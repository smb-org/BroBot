import { describe, expect, it, vi } from "vitest";

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
  scheduleAlarm: vi.fn(() => Promise.resolve()),
  clearAlarm: vi.fn(() => Promise.resolve()),
  ...overrides,
});

describe("chat voting event service", () => {
  it("does not read or mutate a ballot for non-choice chat", async () => {
    const open = vi.fn(() => Promise.resolve(null));
    const repository = repositoryWith({ open });
    const context = executionContext();

    const result = await processChatVotingMessage(eventWithText("hello 1"), repository, context);

    expect(result.actions).toEqual([]);
    expect(open).not.toHaveBeenCalled();
    expect(context.ballots.cast).not.toHaveBeenCalled();
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
      payload: { pollId: "fictional-poll", counts: [0, 1], revision: 1 },
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
    const repository = repositoryWith({ insertOpen });
    const openedAt = Date.parse("2026-10-04T10:00:00.000Z");
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
    expect(ballots.open).toHaveBeenCalledWith(expect.any(String), 2, openedAt + 24 * 60 * 60 * 1_000 - 60_000);
    expect(insertOpen).toHaveBeenCalledWith(expect.objectContaining<Partial<ChatVoteDraft>>({
      channelId: "fictional-channel",
      preset: "yes_no",
      closeReason: "limit",
    }), undefined);
    expect(scheduleClose).toHaveBeenCalledWith(expect.any(String), openedAt + 4 * 60 * 60 * 1_000);
  });
});
