import { describe, expect, it, vi } from "vitest";

import type { ModuleEvent, ModuleExecutionContext } from "../../src/modules/contract";
import { votekickModule } from "../../src/modules/votekick";
import { votekickSettingsSchema, type Votekick } from "../../src/modules/votekick/contracts";
import { votekickThreshold } from "../../src/modules/votekick/domain";
import { processVotekickMessage } from "../../src/modules/votekick/service";
import type { VotekickRepository } from "../../src/modules/votekick/repository";
import { moduleScopePurpose } from "../../src/dashboard/module-labels";

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
  durationSeconds: null,
  startedAt: now(),
  endsAt: new Date(Date.now() + 30_000).toISOString(),
  endedAt: null,
  liftedAt: null,
  ...overrides,
});

const repositoryFor = (overrides: Partial<VotekickRepository> = {}): VotekickRepository => ({
  channelEndedAt: vi.fn(() => Promise.resolve(null)),
  targetStartedAt: vi.fn(() => Promise.resolve(null)),
  insertRunning: vi.fn(() => Promise.resolve(true)),
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
    const insertRunning = vi.fn(() => Promise.resolve(true));
    const repository = repositoryFor({ insertRunning });
    const context = contextFor({ activeChatters: {
      count: vi.fn(() => Promise.resolve(40)),
      seen: vi.fn((userId: string) => Promise.resolve(userId === "sampleviewer-id"
        ? { firstSeenAt: now(), lastSeenAt: now() }
        : { firstSeenAt: new Date(Date.now() - 5_000).toISOString(), lastSeenAt: now() })),
    } });
    const result = await processVotekickMessage(eventFor("!votekick sampleviewer"), repository, context);

    expect(context.ballots.open).toHaveBeenCalledWith(expect.any(String), 2, expect.any(Number));
    expect(context.ballots.cast).toHaveBeenCalledWith(expect.any(String), "starter-user", 1);
    expect(insertRunning).toHaveBeenCalledWith("channel-a", expect.objectContaining({ threshold: 8, targetLogin: "sampleviewer", initiatorUserId: "starter-user" }));
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
      ballots: {
        open: vi.fn(() => Promise.resolve({ status: "opened" as const })),
        cast: vi.fn(() => Promise.resolve({ status: "counted" as const, counts: [3, 0], revision: 3 })),
        read: vi.fn(() => Promise.resolve(null)),
        close: vi.fn(() => Promise.resolve({ counts: [3, 0], revision: 4 })),
      },
    });
    const result = await processVotekickMessage(eventFor("1", ["viewer"], "voter-user"), repository, context);

    expect(finish).toHaveBeenCalledWith("channel-a", "ballot-1", "passed", 3, 0, 120, expect.any(String));
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

  it("uses the atomic close snapshot instead of a stale threshold-crossing cast", async () => {
    const running = runningVotekick();
    const finish = vi.fn(() => Promise.resolve(true));
    const repository = repositoryFor({ running: vi.fn(() => Promise.resolve(running)), finish });
    const context = contextFor({
      ballots: {
        open: vi.fn(() => Promise.resolve({ status: "opened" as const })),
        cast: vi.fn(() => Promise.resolve({ status: "counted" as const, counts: [3, 0], revision: 3 })),
        read: vi.fn(() => Promise.resolve(null)),
        close: vi.fn(() => Promise.resolve({ counts: [1, 2], revision: 4 })),
      },
    });

    const result = await processVotekickMessage(eventFor("1", ["viewer"], "voter-user"), repository, context);

    expect(finish).toHaveBeenCalledWith("channel-a", "ballot-1", "expired", 1, 2, null, expect.any(String));
    expect(result.actions).toEqual([]);
    expect(context.clearAlarm).toHaveBeenCalledWith("close:ballot-1");
  });
});
