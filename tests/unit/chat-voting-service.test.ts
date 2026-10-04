import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ModuleEvent, ModuleExecutionContext } from "../../src/modules/contract";
import {
  DEFAULT_CHAT_VOTING_SETTINGS,
  type ChatVote,
  type ChatVoteDraft,
  type ChatVotingSettings,
} from "../../src/modules/chat_voting/contracts";
import type { ChatVotingRepository } from "../../src/modules/chat_voting/repository";
import { processChatVotingMessage, startChatVote } from "../../src/modules/chat_voting/service";

const openVote: ChatVote = {
  id: "fictional-poll",
  channelId: "fictional-channel",
  preset: "yes_no",
  optionCount: 2,
  labels: ["Yes", "No"],
  status: "open",
  openedAt: "2026-10-04T10:00:00.000Z",
  closesAt: "2026-10-04T14:00:00.000Z",
  closedAt: null,
  closeReason: "limit",
  counts: null,
  voterCount: null,
};

const repositoryWith = (overrides: Partial<ChatVotingRepository> = {}): ChatVotingRepository => ({
  open: vi.fn(() => Promise.resolve(null)),
  latest: vi.fn(() => Promise.resolve(null)),
  byId: vi.fn(() => Promise.resolve(null)),
  insertOpen: vi.fn(() => Promise.resolve(true)),
  requestManualClose: vi.fn(() => Promise.resolve(true)),
  finish: vi.fn(() => Promise.resolve(true)),
  ...overrides,
});

const eventWithText = (text: string, chatStatus: readonly ("viewer" | "moderator" | "broadcaster")[] | null = null): ModuleEvent<ChatVotingSettings> => ({
  channelId: "fictional-channel",
  subscriptionType: "channel.chat.message",
  triggerId: "fictional-trigger",
  payload: { message: { text }, chatter_user_id: "fictional-voter-1" },
  settings: DEFAULT_CHAT_VOTING_SETTINGS,
  receivedAt: "2026-10-04T10:00:00.000Z",
  actor: null,
  chatStatus,
});

const executionContext = (overrides: Partial<ModuleExecutionContext> = {}): ModuleExecutionContext => ({
  DB: {} as D1Database,
  authorizeMutation: vi.fn(() => ({ sql: "", values: [] })),
  ballots: {
    open: vi.fn(() => Promise.resolve({ status: "opened" as const })),
    cast: vi.fn(() => Promise.resolve({ status: "counted" as const, counts: [0, 1], revision: 1 })),
    read: vi.fn(() => Promise.resolve(null)),
    close: vi.fn(() => Promise.resolve(null)),
    acknowledgeClosed: vi.fn(() => Promise.resolve()),
  },
  streamState: vi.fn(() => Promise.resolve("unknown" as const)),
  chatActivityCount: vi.fn(() => Promise.resolve(0)),
  activeChatters: { count: vi.fn(() => Promise.resolve(0)), seen: vi.fn(() => Promise.resolve(null)) },
  channelInfo: vi.fn(() => Promise.resolve(null)),
  followedAt: vi.fn(() => Promise.resolve(null)),
  followerTotal: vi.fn(() => Promise.resolve(null)),
  chattersTotal: vi.fn(() => Promise.resolve(null)),
  userCreatedAt: vi.fn(() => Promise.resolve(null)),
  readChannelVariables: vi.fn(() => Promise.resolve({})),
  renderTemplate: vi.fn((text: string) => Promise.resolve({ text, diagnostics: [] })),
  prepareVariableChange: vi.fn(() => ({} as D1PreparedStatement)),
  channelLanguage: vi.fn(() => Promise.resolve("en" as const)),
  channelTimeZone: vi.fn(() => Promise.resolve("UTC")),
  secureRandomInteger: vi.fn(() => 0),
  scheduleAlarm: vi.fn(() => Promise.resolve()),
  clearAlarm: vi.fn(() => Promise.resolve()),
  ...overrides,
});

describe("chat voting event service", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-04T11:00:00.000Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("does not read or mutate a ballot for non-choice chat", async () => {
    const open = vi.fn(() => Promise.resolve(null));
    const repository = repositoryWith({ open });
    const botUserId = vi.fn(() => Promise.resolve("fictional-bot"));
    const context = executionContext({ botUserId });

    const result = await processChatVotingMessage(eventWithText("hello 1"), repository, context);

    expect(result.actions).toEqual([]);
    expect(open).not.toHaveBeenCalled();
    expect(context.ballots.cast).not.toHaveBeenCalled();
    expect(botUserId).not.toHaveBeenCalled();
  });

  it("publishes the latest ballot counts and revision for a valid digit choice", async () => {
    const repository = repositoryWith({ open: vi.fn(() => Promise.resolve(openVote)) });
    const context = executionContext();

    const result = await processChatVotingMessage(eventWithText("2"), repository, context);

    expect(context.ballots.cast).toHaveBeenCalledWith("fictional-poll", "fictional-voter-1", 2);
    expect(result.actions).toEqual([{
      kind: "overlay",
      type: "tally",
      elementKind: "chat_voting.tally",
      payload: { pollId: "fictional-poll", openedAt: openVote.openedAt, counts: [0, 1], revision: 1 },
    }]);
  });

  it("opens the shared ballot before writing the row and schedules the hard-limit alarm", async () => {
    const ballots = {
      open: vi.fn(() => Promise.resolve({ status: "opened" as const })),
      cast: vi.fn(() => Promise.resolve({ status: "not_open" as const, counts: [0, 0], revision: 0 })),
      read: vi.fn(() => Promise.resolve(null)),
      close: vi.fn(() => Promise.resolve(null)),
    };
    const insertOpen = vi.fn(() => Promise.resolve(true));
    const openedAt = Date.parse("2026-10-04T10:00:00.000Z");
    const latestVote = { ...openVote, status: "closed" as const, openedAt: new Date(openedAt).toISOString() };
    const repository = repositoryWith({
      insertOpen,
      latest: vi.fn(() => Promise.resolve(latestVote)),
    });
    const effectiveOpenedAt = openedAt + 1;
    const scheduleClose = vi.fn(() => Promise.resolve());

    const result = await startChatVote(repository, {
      channelId: "fictional-channel",
      preset: "yes_no",
      optionCount: 2,
      settings: DEFAULT_CHAT_VOTING_SETTINGS,
      language: "en",
      openedAt,
    }, ballots, scheduleClose);

    expect(result.status).toBe("started");
    expect(ballots.open).toHaveBeenCalledWith(expect.any(String), 2, effectiveOpenedAt + 24 * 60 * 60 * 1_000 - 60_000);
    expect(insertOpen).toHaveBeenCalledWith(expect.objectContaining<Partial<ChatVoteDraft>>({
      channelId: "fictional-channel",
      preset: "yes_no",
      closeReason: "limit",
    }), undefined);
    expect(scheduleClose).toHaveBeenCalledWith(expect.any(String), effectiveOpenedAt + 4 * 60 * 60 * 1_000, 0);
    expect(result).toMatchObject({ status: "started", vote: { openedAt: new Date(effectiveOpenedAt).toISOString() } });
  });

  it("releases the close recovery snapshot when another open vote makes the insert busy", async () => {
    const ballots = executionContext().ballots;
    const repository = repositoryWith({ insertOpen: vi.fn(() => Promise.resolve(false)) });

    const result = await startChatVote(repository, {
      channelId: "fictional-channel",
      preset: "yes_no",
      optionCount: 2,
      settings: DEFAULT_CHAT_VOTING_SETTINGS,
      language: "en",
    }, ballots, vi.fn(() => Promise.resolve()));

    expect(result.status).toBe("busy");
    expect(ballots.close).toHaveBeenCalledOnce();
    expect(ballots.acknowledgeClosed).toHaveBeenCalledOnce();
  });

  it("does not cast a choice after closesAt even if the host ballot remains open", async () => {
    const repository = repositoryWith({ open: vi.fn(() => Promise.resolve({ ...openVote, closesAt: "2000-01-01T00:00:00.000Z" })) });
    const context = executionContext();

    const result = await processChatVotingMessage(eventWithText("1"), repository, context);

    expect(result.actions).toEqual([]);
    expect(context.ballots.cast).not.toHaveBeenCalled();
  });

  it("rejects !vote end from a viewer and schedules a moderator close with a newer alarm revision", async () => {
    const requestManualClose = vi.fn(() => Promise.resolve(true));
    const repository = repositoryWith({
      open: vi.fn(() => Promise.resolve(openVote)),
      requestManualClose,
    });
    const context = executionContext();

    const denied = await processChatVotingMessage(eventWithText("!vote end", ["viewer"]), repository, context);
    expect(denied.actions).toEqual([]);
    expect(requestManualClose).not.toHaveBeenCalled();

    const allowed = await processChatVotingMessage(eventWithText("!vote end", ["moderator"]), repository, context);
    expect(allowed.actions).toEqual([{ kind: "chat", text: "The vote is closing.", automated: false }]);
    expect(requestManualClose).toHaveBeenCalledWith("fictional-channel", "fictional-poll", undefined);
    expect(context.scheduleAlarm).toHaveBeenCalledWith("close", "fictional-poll", expect.any(Number), 1);
  });
});
