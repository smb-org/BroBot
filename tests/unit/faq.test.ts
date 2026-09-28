import { describe, expect, it, vi } from "vitest";

import type { BotModule, ModuleEvent, ModuleExecutionContext } from "../../src/modules/contract";
import type { FaqEntry } from "../../src/modules/faq/contracts";
import { createFaqRepository } from "../../src/modules/faq/adapters/d1";
import { firstFaqMatch, normalizeFaqText, prepareFaqMatchers, validFaqMatcher } from "../../src/modules/faq/domain";
import { processFaqMessage } from "../../src/modules/faq/service";
import { faqModule } from "../../src/modules/faq";
import { textCommandModule } from "../../src/modules/text_commands";
import { selectModulesForEvent } from "../../src/worker/dispatch";
import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

const NOW = "2026-09-19T12:00:00.000Z";

const faqEntry = (overrides: Partial<FaqEntry> = {}): FaqEntry => ({
  id: "faq-entry",
  name: "Sunset FAQ",
  enabled: true,
  matcher: { type: "keywords", patterns: ["get dark"] },
  answerBlock: "sun",
  cooldownSeconds: 60,
  games: [],
  chatTarget: "source_only",
  order: 0,
  revision: 1,
  lastUsedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const eventFor = (text: string, sender = "viewer-1"): ModuleEvent => ({
  channelId: "channel-a",
  subscriptionType: "channel.chat.message",
  triggerId: "message-1",
  payload: { message: { text }, chatter_user_id: sender },
  settings: {},
  receivedAt: NOW,
  actor: null,
  chatStatus: ["viewer"],
});

const contextFor = (db: TestD1Database, gameId: string | null = null) => ({
  DB: db as unknown as D1Database,
  botUserId: vi.fn(() => Promise.resolve("bot-user")),
  channelGameId: vi.fn(() => Promise.resolve(gameId)),
  renderTemplate: vi.fn((text: string) => Promise.resolve({
    text: text === "{sun}" ? "The sun block answer." : text,
    diagnostics: [],
  })),
}) as unknown as ModuleExecutionContext;

describe("FAQ literal matcher", () => {
  it("normalizes case and accents while keeping Unicode word boundaries", () => {
    expect(normalizeFaqText("  CAFÉ\tbei Nacht  ")).toBe("cafe bei nacht");
    const prepared = prepareFaqMatchers([faqEntry({ matcher: { type: "keywords", patterns: ["café", "get dark"] } })]);
    expect(firstFaqMatch(prepared, "WHEN does it get dark?").match?.matchedPattern).toBe("get dark");
    expect(firstFaqMatch(prepared, "the darkness arrives").match).toBeNull();
    expect(firstFaqMatch(prepared, "Would you like a CAFE?").match?.matchedPattern).toBe("café");
    expect(firstFaqMatch(prepared, "Cafeteria is open").match).toBeNull();
  });

  it("uses explicit order for the winner and skips every command-prefixed message", () => {
    const prepared = prepareFaqMatchers([
      faqEntry({ id: "second", name: "Second", order: 4, matcher: { type: "keywords", patterns: ["get dark"] } }),
      faqEntry({ id: "first", name: "First", order: 1, matcher: { type: "keywords", patterns: ["dark"] } }),
    ]);
    expect(firstFaqMatch(prepared, "get dark").match?.entry.id).toBe("first");
    expect(firstFaqMatch(prepared, "!help get dark")).toEqual({ match: null, reason: "command_prefix" });
  });

  it("rejects regex matchers, including patterns with catastrophic backtracking", () => {
    expect(validFaqMatcher({ type: "regex", pattern: "(a+)+$" })).toBe(false);
  });

  it("keeps a warmed 100-entry lookup under the shared 10 ms chat CPU budget", () => {
    const entries = Array.from({ length: 100 }, (_, index) => faqEntry({
      id: `entry-${String(index).padStart(3, "0")}`,
      name: `Entry ${String(index)}`,
      order: index,
      matcher: { type: "keywords", patterns: [`unused phrase ${String(index)}`, `other term ${String(index)}`, ...(index === 99 ? ["get dark"] : [])] },
    }));
    const prepared = prepareFaqMatchers(entries);
    firstFaqMatch(prepared, "When does it get dark after the evening stream?");
    firstFaqMatch(prepared, "When does it get dark after the evening stream?");
    const durations: number[] = [];
    for (let index = 0; index < 7; index += 1) {
      const start = performance.now();
      firstFaqMatch(prepared, "When does it get dark after the evening stream?");
      durations.push(performance.now() - start);
    }
    const minimumMs = Math.min(...durations);
    const maximumMs = Math.max(...durations);
    console.info(`FAQ matcher with 100 entries: ${minimumMs.toFixed(3)} ms minimum, ${maximumMs.toFixed(3)} ms maximum`);
    expect(maximumMs).toBeLessThan(10);
  });

  it("runs after text commands even when the activation rows arrive in the opposite order", () => {
    const registry = [textCommandModule, faqModule] as readonly BotModule[];
    const result = selectModulesForEvent([
      { moduleId: "faq", enabled: true, settings: "{}" },
      { moduleId: "text_commands", enabled: true, settings: "{}" },
    ], "channel.chat.message", registry);
    expect(result.matches.map(({ module }) => module.id)).toEqual(["text_commands", "faq"]);
  });

  it("answers the first matching block once and then observes its per-entry cooldown", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "channel-a");
      await database.prepare(
        `INSERT INTO faq_entries
          (faq_id, channel_id, name, enabled, matcher_type, matcher_json, answer_block, cooldown_seconds,
           games_json, chat_target, sort_order, revision, last_used_at, created_at, updated_at)
         VALUES ('faq-1', 'channel-a', 'Sunset', 1, 'keywords', ?, 'sun', 60, '[]', 'source_only', 0, 1, NULL, ?, ?)`,
      ).bind(JSON.stringify({ type: "keywords", patterns: ["get dark"] }), NOW, NOW).run();
      const repository = createFaqRepository(database as unknown as D1Database);
      const context = contextFor(database);

      const first = await processFaqMessage(eventFor("When does it get dark?"), repository, context);
      const second = await processFaqMessage({ ...eventFor("When does it get dark?"), triggerId: "message-2" }, repository, context);
      expect(first.actions).toEqual([{ kind: "chat", text: "The sun block answer.", target: "source_only" }]);
      expect(second.actions).toEqual([]);
      expect(context.renderTemplate).toHaveBeenCalledTimes(1);
    } finally {
      database.close();
    }
  });

  it("does not match its own bot messages and passes unknown game state through", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "channel-a");
      await database.prepare(
        `INSERT INTO faq_entries
          (faq_id, channel_id, name, enabled, matcher_type, matcher_json, answer_block, cooldown_seconds,
           games_json, chat_target, sort_order, revision, last_used_at, created_at, updated_at)
         VALUES ('faq-1', 'channel-a', 'Sunset', 1, 'keywords', ?, 'sun', 0, ?, 'source_only', 0, 1, NULL, ?, ?)`,
      ).bind(JSON.stringify({ type: "keywords", patterns: ["get dark"] }), JSON.stringify([{ id: "77", name: "Game" }]), NOW, NOW).run();
      const repository = createFaqRepository(database as unknown as D1Database);
      const context = contextFor(database, null);
      const ownMessage = await processFaqMessage(eventFor("When does it get dark?", "bot-user"), repository, context);
      const unknownGame = await processFaqMessage(eventFor("When does it get dark?"), repository, context);
      expect(ownMessage.actions).toEqual([]);
      expect(unknownGame.actions).toHaveLength(1);
      expect(context.renderTemplate).toHaveBeenCalledTimes(1);
    } finally {
      database.close();
    }
  });
});
