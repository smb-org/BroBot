import { describe, expect, it, vi } from "vitest";

import type { BotModule, ModuleEvent, ModuleExecutionContext } from "../../src/modules/contract";
import type { FaqEntry } from "../../src/modules/faq/contracts";
import { createFaqRepository } from "../../src/modules/faq/adapters/d1";
import { firstFaqMatch, normalizeFaqText, prepareFaqMatchers, selectFaqMatch, validFaqMatcher } from "../../src/modules/faq/domain";
import { processFaqMessage, testFaqMessage } from "../../src/modules/faq/service";
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
  isRecentBotMessage: vi.fn(() => Promise.resolve(false)),
  channelGameId: vi.fn(() => Promise.resolve(gameId)),
  renderTemplate: vi.fn((text: string) => Promise.resolve({
    text: text === "{sun}" ? "The sun block answer." : text,
    diagnostics: [],
  })),
}) as unknown as ModuleExecutionContext;

describe("FAQ literal matcher", () => {
  it("normalizes case and accents while keeping Unicode word boundaries", () => {
    expect(normalizeFaqText("  CAFÉ\tbei Nacht  ")).toBe("cafe bei nacht");
    expect(normalizeFaqText("Straße ẞ")).toBe("strasse ss");
    const prepared = prepareFaqMatchers([faqEntry({ matcher: { type: "keywords", patterns: ["café", "get dark"] } })]);
    expect(firstFaqMatch(prepared, "WHEN does it get dark?").match?.matchedPattern).toBe("get dark");
    expect(firstFaqMatch(prepared, "the darkness arrives").match).toBeNull();
    expect(firstFaqMatch(prepared, "Would you like a CAFE?").match?.matchedPattern).toBe("café");
    expect(firstFaqMatch(prepared, "Cafeteria is open").match).toBeNull();
    const umlautMatcher = prepareFaqMatchers([faqEntry({ matcher: { type: "keywords", patterns: ["Straße"] } })]);
    expect(firstFaqMatch(umlautMatcher, "STRASSE").match?.matchedPattern).toBe("Straße");
    const emojiMatcher = prepareFaqMatchers([faqEntry({ matcher: { type: "keywords", patterns: ["😂"] } })]);
    expect(firstFaqMatch(emojiMatcher, "lol😂").match?.matchedPattern).toBe("😂");
  });

  it("filters game-bound entries before selecting the first phrase match", () => {
    const prepared = prepareFaqMatchers([
      faqEntry({ id: "other-game", name: "Other game", order: 0, games: [{ id: "77", name: "Game" }] }),
      faqEntry({ id: "any-game", name: "Any game", order: 1, games: [] }),
    ]);
    const eligible = prepared.filter(({ entry }) => entry.games.length === 0);
    expect(firstFaqMatch(eligible, "When does it get dark?").match?.entry.id).toBe("any-game");
  });

  it("uses the minimum cooldown as the migration default and database constraint", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "channel-a");
      await database.prepare(
        `INSERT INTO faq_entries
          (faq_id, channel_id, name, matcher_json, answer_block, created_at, updated_at)
         VALUES ('defaulted', 'channel-a', 'Defaulted', '{"type":"keywords","patterns":["hello"]}', 'sun', ?, ?)`,
      ).bind(NOW, NOW).run();
      await expect(database.prepare("SELECT cooldown_seconds FROM faq_entries WHERE faq_id = 'defaulted'")
        .first<{ cooldown_seconds: number }>()).resolves.toEqual({ cooldown_seconds: 30 });
      await expect(database.prepare(
        `INSERT INTO faq_entries
          (faq_id, channel_id, name, matcher_json, answer_block, cooldown_seconds, created_at, updated_at)
         VALUES ('too-short', 'channel-a', 'Too short', '{"type":"keywords","patterns":["hello"]}', 'sun', 29, ?, ?)`,
      ).bind(NOW, NOW).run()).rejects.toThrow();
    } finally {
      database.close();
    }
  });

  it("uses explicit order for the winner and skips every command-prefixed message", () => {
    const prepared = prepareFaqMatchers([
      faqEntry({ id: "second", name: "Second", order: 4, matcher: { type: "keywords", patterns: ["get dark"] } }),
      faqEntry({ id: "first", name: "First", order: 1, matcher: { type: "keywords", patterns: ["dark"] } }),
    ]);
    expect(firstFaqMatch(prepared, "get dark").match?.entry.id).toBe("first");
    expect(firstFaqMatch(prepared, "!help get dark")).toEqual({ match: null, reason: "command_prefix" });
  });

  it("reports a game-restricted match it skipped, then still finds a later eligible one", () => {
    const prepared = prepareFaqMatchers([
      faqEntry({ id: "wrong-game", name: "Other game", order: 0, games: [{ id: "77", name: "Other" }], matcher: { type: "keywords", patterns: ["get dark"] } }),
      faqEntry({ id: "eligible", name: "Any game", order: 1, games: [], matcher: { type: "keywords", patterns: ["get dark"] } }),
    ]);
    const withoutGame = selectFaqMatch(prepared, "When does it get dark?", null);
    expect(withoutGame.match?.entry.id).toBe("eligible");
    expect(withoutGame.skippedByGame).toEqual([{ entry: prepared[0]?.entry, matchedPattern: "get dark" }]);

    const withMatchingGame = selectFaqMatch(prepared, "When does it get dark?", "77");
    expect(withMatchingGame.match?.entry.id).toBe("wrong-game");
    expect(withMatchingGame.skippedByGame).toEqual([]);
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

  it("answers the first matching block once and commits cooldown after confirmed delivery", async () => {
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
      expect(first.actions).toHaveLength(1);
      const action = first.actions[0];
      expect(action).toMatchObject({ kind: "chat", text: "The sun block answer.", target: "source_only", automated: true });
      if (action?.kind !== "chat" || action.onDelivery === undefined) throw new Error("FAQ answer delivery callback is missing.");
      await action.onDelivery("sent");
      expect(second.actions).toEqual([]);
      expect(context.renderTemplate).toHaveBeenCalledTimes(2);
    } finally {
      database.close();
    }
  });

  it("does not match its own bot messages or answer while the current game is unknown", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "channel-a");
      await database.prepare(
        `INSERT INTO faq_entries
          (faq_id, channel_id, name, enabled, matcher_type, matcher_json, answer_block, cooldown_seconds,
           games_json, chat_target, sort_order, revision, last_used_at, created_at, updated_at)
         VALUES ('faq-1', 'channel-a', 'Sunset', 1, 'keywords', ?, 'sun', 30, ?, 'source_only', 0, 1, NULL, ?, ?)`,
      ).bind(JSON.stringify({ type: "keywords", patterns: ["get dark"] }), JSON.stringify([{ id: "77", name: "Game" }]), NOW, NOW).run();
      const repository = createFaqRepository(database as unknown as D1Database);
      const context = contextFor(database, null);
      const ownMessage = await processFaqMessage(eventFor("When does it get dark?", "bot-user"), repository, context);
      const unknownGame = await processFaqMessage(eventFor("When does it get dark?"), repository, context);
      expect(ownMessage.actions).toEqual([]);
      expect(unknownGame.actions).toEqual([]);
      expect(context.renderTemplate).not.toHaveBeenCalled();
      const recentBotContext = {
        ...contextFor(database),
        isRecentBotMessage: vi.fn(() => Promise.resolve(true)),
      };
      const repeatedBotText = await processFaqMessage(eventFor("When does it get dark?", "old-bot-user"), repository, recentBotContext);
      expect(repeatedBotText.actions).toEqual([]);
      expect(recentBotContext.renderTemplate).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it("only resolves the current game for a keyword hit against a game-bound entry, never for a miss", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "channel-a");
      await database.prepare(
        `INSERT INTO faq_entries
          (faq_id, channel_id, name, enabled, matcher_type, matcher_json, answer_block, cooldown_seconds,
           games_json, chat_target, sort_order, revision, last_used_at, created_at, updated_at)
         VALUES
          ('any-game', 'channel-a', 'Any game', 1, 'keywords', ?, 'sun', 30, '[]', 'source_only', 0, 1, NULL, ?, ?),
          ('boss-fight', 'channel-a', 'Boss fight', 1, 'keywords', ?, 'night', 30, ?, 'source_only', 1, 1, NULL, ?, ?)`,
      ).bind(
        JSON.stringify({ type: "keywords", patterns: ["get dark"] }), NOW, NOW,
        JSON.stringify({ type: "keywords", patterns: ["boss fight"] }), JSON.stringify([{ id: "77", name: "Game" }]), NOW, NOW,
      ).run();
      const repository = createFaqRepository(database as unknown as D1Database);
      const context = contextFor(database, "77");

      // A hundred unrelated messages: no keyword matches at all, so no
      // channel lookup is ever needed.
      for (let index = 0; index < 100; index += 1) {
        await processFaqMessage({ ...eventFor("just chatting, nothing to see"), triggerId: `miss-${String(index)}` }, repository, context);
      }
      expect(context.channelGameId).not.toHaveBeenCalled();

      // Matches an unrestricted entry: still no lookup needed.
      await processFaqMessage({ ...eventFor("When does it get dark?"), triggerId: "unrestricted" }, repository, context);
      expect(context.channelGameId).not.toHaveBeenCalled();

      // Matches only the game-bound entry: exactly one lookup, only now.
      const result = await processFaqMessage({ ...eventFor("any boss fight tips?"), triggerId: "game-bound" }, repository, context);
      expect(result.actions).toMatchObject([{ kind: "chat", text: "{night}" }]);
      expect(context.channelGameId).toHaveBeenCalledTimes(1);
    } finally {
      database.close();
    }
  });

  it("tries the next phrase match when the earlier entry is bound to another game", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "channel-a");
      await database.prepare(
        `INSERT INTO faq_entries
          (faq_id, channel_id, name, enabled, matcher_type, matcher_json, answer_block, cooldown_seconds,
           games_json, chat_target, sort_order, revision, last_used_at, created_at, updated_at)
         VALUES
          ('wrong-game', 'channel-a', 'Other game', 1, 'keywords', ?, 'sun', 30, ?, 'source_only', 0, 1, NULL, ?, ?),
          ('eligible', 'channel-a', 'Any game', 1, 'keywords', ?, 'night', 30, '[]', 'source_only', 1, 1, NULL, ?, ?)`,
      ).bind(
        JSON.stringify({ type: "keywords", patterns: ["get dark"] }), JSON.stringify([{ id: "77", name: "Other" }]), NOW, NOW,
        JSON.stringify({ type: "keywords", patterns: ["get dark"] }), NOW, NOW,
      ).run();
      const repository = createFaqRepository(database as unknown as D1Database);
      const context = contextFor(database, "88");
      const result = await processFaqMessage(eventFor("When does it get dark?"), repository, context);
      expect(result.actions).toMatchObject([{ kind: "chat", text: "{night}" }]);
    } finally {
      database.close();
    }
  });

  it("resolves the game before an unrestricted later entry can win over an eligible earlier one", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "channel-a");
      await database.prepare(
        `INSERT INTO faq_entries
          (faq_id, channel_id, name, enabled, matcher_type, matcher_json, answer_block, cooldown_seconds,
           games_json, chat_target, sort_order, revision, last_used_at, created_at, updated_at)
         VALUES
          ('boss-fight', 'channel-a', 'Boss fight', 1, 'keywords', ?, 'boss', 30, ?, 'source_only', 0, 1, NULL, ?, ?),
          ('any-game', 'channel-a', 'Any game', 1, 'keywords', ?, 'generic', 30, '[]', 'source_only', 1, 1, NULL, ?, ?)`,
      ).bind(
        JSON.stringify({ type: "keywords", patterns: ["get dark"] }), JSON.stringify([{ id: "77", name: "Game" }]), NOW, NOW,
        JSON.stringify({ type: "keywords", patterns: ["get dark"] }), NOW, NOW,
      ).run();
      const repository = createFaqRepository(database as unknown as D1Database);
      // The real current game (77) matches the earlier, game-bound entry: it
      // must win over the later unrestricted one, even though the cheap
      // no-game scan would have found the unrestricted entry first.
      const context = contextFor(database, "77");
      const result = await processFaqMessage(eventFor("When does it get dark?"), repository, context);
      expect(result.actions).toMatchObject([{ kind: "chat", text: "{boss}" }]);
      expect(context.channelGameId).toHaveBeenCalledTimes(1);
    } finally {
      database.close();
    }
  });

  it("lets the panel tester see the same game filter and skip reason as live chat", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "channel-a");
      await database.prepare(
        `INSERT INTO faq_entries
          (faq_id, channel_id, name, enabled, matcher_type, matcher_json, answer_block, cooldown_seconds,
           games_json, chat_target, sort_order, revision, last_used_at, created_at, updated_at)
         VALUES ('wrong-game', 'channel-a', 'Other game', 1, 'keywords', ?, 'sun', 30, ?, 'source_only', 0, 1, NULL, ?, ?)`,
      ).bind(JSON.stringify({ type: "keywords", patterns: ["get dark"] }), JSON.stringify([{ id: "77", name: "Other" }]), NOW, NOW).run();
      const repository = createFaqRepository(database as unknown as D1Database);

      const noGame = await testFaqMessage(repository, "channel-a", "When does it get dark?", null);
      expect(noGame.match).toBeNull();
      expect(noGame.skippedByGame).toMatchObject([{ entry: { id: "wrong-game" }, matchedPattern: "get dark" }]);

      const matchingGame = await testFaqMessage(repository, "channel-a", "When does it get dark?", "77");
      expect(matchingGame.match?.entry.id).toBe("wrong-game");
      expect(matchingGame.skippedByGame).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("releases a cooldown after definite rejection and never claims empty renders", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "channel-a");
      await database.prepare(
        `INSERT INTO faq_entries
          (faq_id, channel_id, name, enabled, matcher_type, matcher_json, answer_block, cooldown_seconds,
           games_json, chat_target, sort_order, revision, last_used_at, created_at, updated_at)
         VALUES ('faq-1', 'channel-a', 'Sunset', 1, 'keywords', ?, 'sun', 30, '[]', 'source_only', 0, 1, NULL, ?, ?)`,
      ).bind(JSON.stringify({ type: "keywords", patterns: ["get dark"] }), NOW, NOW).run();
      const repository = createFaqRepository(database as unknown as D1Database);
      const context = contextFor(database);
      const rejected = await processFaqMessage(eventFor("When does it get dark?"), repository, context);
      const rejectedAction = rejected.actions[0];
      if (rejectedAction?.kind !== "chat" || rejectedAction.onDelivery === undefined) throw new Error("FAQ answer delivery callback is missing.");
      await rejectedAction.onDelivery("rejected");
      await expect(database.prepare("SELECT last_used_at FROM faq_entries WHERE faq_id = 'faq-1'")
        .first<{ last_used_at: string | null }>()).resolves.toEqual({ last_used_at: null });

      const emptyContext = {
        ...contextFor(database),
        renderTemplate: vi.fn(() => Promise.resolve({ text: "", diagnostics: [] })),
      };
      const empty = await processFaqMessage({ ...eventFor("When does it get dark?"), triggerId: "message-empty" }, repository, emptyContext);
      expect(empty.actions).toEqual([]);
      await expect(database.prepare("SELECT last_used_at FROM faq_entries WHERE faq_id = 'faq-1'")
        .first<{ last_used_at: string | null }>()).resolves.toEqual({ last_used_at: null });

      const next = await processFaqMessage({ ...eventFor("When does it get dark?"), triggerId: "message-next" }, repository, context);
      expect(next.actions).toHaveLength(1);
      const ambiguousAction = next.actions[0];
      if (ambiguousAction?.kind !== "chat" || ambiguousAction.onDelivery === undefined) throw new Error("FAQ answer delivery callback is missing.");
      await ambiguousAction.onDelivery("ambiguous");
      const afterAmbiguous = await processFaqMessage({ ...eventFor("When does it get dark?"), triggerId: "message-ambiguous" }, repository, context);
      expect(afterAmbiguous.actions).toEqual([]);
    } finally {
      database.close();
    }
  });
});
