import { describe, expect, it, vi } from "vitest";

import type { FaqEntry } from "../../src/modules/faq/contracts";
import type { FaqRepository } from "../../src/modules/faq/repository";
import { prepareFaqMatchers } from "../../src/modules/faq/domain";
import { processFaqMessage } from "../../src/modules/faq/service";
import type { ModuleEvent, ModuleExecutionContext } from "../../src/modules/contract";

const entry: FaqEntry = {
  id: "faq-hello",
  name: "Hello",
  enabled: true,
  matcher: { type: "keywords", patterns: ["hello"] },
  answerText: "Hello there!",
  minimumTier: "everyone",
  cooldownSeconds: 30,
  userCooldownSeconds: 0,
  games: [],
  chatTarget: null,
  order: 0,
  revision: 1,
  lastUsedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const eventFor = (text: string): ModuleEvent => ({
  channelId: "channel-a",
  subscriptionType: "channel.chat.message",
  triggerId: "message-1",
  payload: { message: { text }, chatter_user_id: "viewer-1" },
  settings: {},
  receivedAt: "2026-01-01T00:00:00.000Z",
  actor: null,
  chatStatus: ["viewer"],
});

const repositoryFor = (overrides: Partial<FaqRepository> = {}): FaqRepository => ({
  list: vi.fn(() => Promise.resolve([entry])),
  listWithOrderRevision: vi.fn(() => Promise.resolve({ entries: [entry], orderRevision: 1 })),
  matchers: vi.fn(() => Promise.resolve(prepareFaqMatchers([entry]))),
  claim: vi.fn<FaqRepository["claim"]>((_channelId, _entry, _userId, now) => Promise.resolve({ claimed: true, claimedAt: now })),
  releaseClaim: vi.fn(() => Promise.resolve()),
  invalidate: vi.fn(),
  ...overrides,
});

describe("FAQ chat hot path", () => {
  it("matches locally before checking bot echoes", async () => {
    const repository = repositoryFor({ matchers: vi.fn(() => Promise.resolve([])) });
    const botUserId = vi.fn(() => Promise.resolve("bot-1"));
    const isRecentBotMessage = vi.fn<NonNullable<ModuleExecutionContext["isRecentBotMessage"]>>(() => Promise.resolve(false));

    await processFaqMessage(eventFor("an ordinary chat message"), repository, {
      renderTemplate: (text) => Promise.resolve({ text, diagnostics: [] }),
      botUserId,
      isRecentBotMessage,
    });

    expect(botUserId).not.toHaveBeenCalled();
    expect(isRecentBotMessage).not.toHaveBeenCalled();
  });

  it("claims cooldown before rendering and releases it when rendering is empty", async () => {
    const order: string[] = [];
    const repository = repositoryFor({
      claim: vi.fn<FaqRepository["claim"]>((_channelId, _entry, _userId, now) => {
        order.push("claim");
        return Promise.resolve({ claimed: true, claimedAt: now });
      }),
      releaseClaim: vi.fn(() => { order.push("release"); return Promise.resolve(); }),
    });
    const result = await processFaqMessage(eventFor("hello"), repository, {
      renderTemplate: () => {
        order.push("render");
        return Promise.resolve({ text: "", diagnostics: [] });
      },
      botUserId: () => Promise.resolve("bot-1"),
      isRecentBotMessage: () => Promise.resolve(false),
    });

    expect(order).toEqual(["claim", "render", "release"]);
    expect(result.actions).toEqual([]);
  });
});
