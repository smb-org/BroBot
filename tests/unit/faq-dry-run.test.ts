import { afterEach, describe, expect, it, vi } from "vitest";

import type { FaqEntry } from "../../src/modules/faq/contracts";
import { FAQ_CLAIM_ELIGIBLE_SQL, createFaqRepository, peekClaim } from "../../src/modules/faq/adapters/d1";
import { explainFaqMatches, prepareFaqMatchers, selectFaqMatch } from "../../src/modules/faq/domain";
import { faqModule } from "../../src/modules/faq";
import type { ModuleDryRunContext, ModuleEvent } from "../../src/modules/contract";
import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

const NOW = "2026-09-19T12:00:00.000Z";

const faqEntry = (overrides: Partial<FaqEntry> = {}): FaqEntry => ({
  id: "faq-entry",
  name: "FAQ entry",
  enabled: true,
  matcher: { type: "keywords", patterns: ["hello"] },
  answerText: "Hello!",
  minimumTier: "everyone",
  cooldownSeconds: 30,
  userCooldownSeconds: 0,
  games: [],
  chatTarget: null,
  order: 0,
  revision: 1,
  lastUsedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const seedFaqEntry = async (
  database: TestD1Database,
  id: string,
  name: string,
  order: number,
  matcher: { type: "keywords"; patterns: string[] } | { type: "regex"; pattern: string },
  cooldownSeconds = 30,
): Promise<void> => {
  const matcherType = matcher.type;
  const matcherJson = JSON.stringify(matcher);
  await database.prepare(
    `INSERT INTO faq_entries
      (faq_id, channel_id, name, enabled, matcher_type, matcher_json, answer_text, minimum_tier,
       cooldown_seconds, user_cooldown_seconds, games_json, chat_target, use_channel_default_target,
       sort_order, revision, last_used_at, created_at, updated_at)
     VALUES (?, 'channel-a', ?, 1, ?, ?, 'Hello!', 'everyone', ?, 0, '[]', 'where_asked', 1, ?, 1, NULL, ?, ?)`,
  ).bind(id, name, matcherType, matcherJson, cooldownSeconds, order, NOW, NOW).run();
};

const eventFor = (text: string): ModuleEvent<Record<string, never>> => ({
  channelId: "channel-a",
  subscriptionType: "channel.chat.message",
  triggerId: "dry-run",
  payload: { message: { text }, chatter_user_id: "dry-run:viewer_42" },
  settings: {},
  receivedAt: NOW,
  actor: null,
  chatStatus: ["viewer"],
});

const dryRunContextFor = (database: TestD1Database): ModuleDryRunContext => ({
  DB: database as unknown as D1Database,
  defaultChatTarget: "where_asked",
  botUserId: () => Promise.resolve("bot-user"),
  streamState: () => Promise.resolve("online"),
  channelInfo: () => Promise.resolve({ title: "", gameName: "", gameId: "", startedAt: NOW, viewerCount: 0 }),
  channelGameId: () => Promise.resolve(null),
  channelLanguage: () => Promise.resolve("de"),
  channelTimeZone: () => Promise.resolve("Europe/Berlin"),
  readChannelVariables: () => Promise.resolve({}),
  renderTemplate: (text) => Promise.resolve({ text, diagnostics: [] }),
  followedAt: () => Promise.resolve("unavailable"),
  userCreatedAt: () => Promise.resolve(null),
  secureRandomInteger: () => 0,
});

afterEach(() => {
  vi.useRealTimers();
});

describe("FAQ dry-run explanations", () => {
  it("explains every matching entry, including tier, game, and shadowing skips", () => {
    const prepared = prepareFaqMatchers([
      faqEntry({ id: "tier", name: "Tier", order: 0, minimumTier: "moderator" }),
      faqEntry({ id: "game", name: "Game", order: 1, games: [{ id: "game-2", name: "Other game" }] }),
      faqEntry({ id: "winner", name: "Winner", order: 2 }),
      faqEntry({ id: "shadowed", name: "Shadowed", order: 3, matcher: { type: "regex", pattern: "hello" } }),
    ]);

    const explanations = explainFaqMatches(prepared, "🎉 hello hello", "game-1", ["viewer"]);

    expect(explanations.map(({ entry, reason, byEntryId }) => ({ id: entry.id, reason, byEntryId }))).toEqual([
      { id: "tier", reason: "permission_denied", byEntryId: undefined },
      { id: "game", reason: "game_filter", byEntryId: undefined },
      { id: "winner", reason: null, byEntryId: undefined },
      { id: "shadowed", reason: "shadowed", byEntryId: "winner" },
    ]);
    expect(explanations[3]?.match).toEqual({ kind: "regex", pattern: "hello", ranges: [[3, 8], [9, 14]] });
    expect(explanations.find(({ reason }) => reason === null)?.entry.id)
      .toBe(selectFaqMatch(prepared, "🎉 hello hello", "game-1", ["viewer"]).match?.entry.id);
  });

  it("reports a command prefix for matching entries without selecting a winner", () => {
    const prepared = prepareFaqMatchers([faqEntry({ id: "faq-hello" })]);

    const explanations = explainFaqMatches(prepared, "!hello", null, ["viewer"]);

    expect(explanations).toMatchObject([{ entry: { id: "faq-hello" }, reason: "command_prefix" }]);
    expect(selectFaqMatch(prepared, "!hello", null, ["viewer"]).match).toBeNull();
  });

  it("runs the production FAQ service with a read-only claim and reports shadowing and cooldowns", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const database = new TestD1Database();
    try {
      await insertChannel(database, "channel-a");
      await seedFaqEntry(database, "winner", "Winner", 0, { type: "keywords", patterns: ["hello"] });
      await seedFaqEntry(database, "shadowed", "Shadowed", 1, { type: "regex", pattern: "hello" });
      const context = dryRunContextFor(database);
      const run = () => faqModule.dryRunChatMessage?.(eventFor("🎉 hello"), context) ?? Promise.resolve([]);

      const first = await run();
      const second = await run();

      expect(first).toMatchObject([
        { entry: { id: "winner" }, outcome: "fires", match: { kind: "keyword", pattern: "hello" } },
        {
          entry: { id: "shadowed" },
          outcome: "blocked",
          match: { kind: "regex", pattern: "hello", ranges: [[3, 8]] },
          blocks: [{ code: "faq.shadowed", detail: { byEntryId: "winner" } }],
        },
      ]);
      expect(second).toEqual(first);
      const commandPrefix = await faqModule.dryRunChatMessage?.(eventFor("!hello"), context) ?? [];
      const ownMessageEvent = {
        ...eventFor("hello"),
        payload: { ...eventFor("hello").payload, chatter_user_id: "bot-user" },
      };
      const ownMessage = await faqModule.dryRunChatMessage?.(ownMessageEvent, context) ?? [];
      expect(commandPrefix[0]).toMatchObject({ outcome: "blocked", blocks: [{ code: "faq.command_prefix" }] });
      expect(ownMessage[0]).toMatchObject({ outcome: "blocked", blocks: [{ code: "faq.own_message" }] });
      await database.prepare("UPDATE faq_entries SET last_used_at = ? WHERE faq_id = 'winner'").bind(NOW).run();

      const blocked = await run();

      expect(blocked[0]).toMatchObject({
        entry: { id: "winner" },
        outcome: "blocked",
        blocks: [{ code: "faq.cooldown", detail: { remainingSeconds: 30 } }],
        effects: [],
      });
    } finally {
      database.close();
    }
  });

  it("peeks with the same eligibility predicate as the production claim without consuming it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const database = new TestD1Database();
    try {
      await insertChannel(database, "channel-a");
      await seedFaqEntry(database, "faq-hello", "Greeting", 0, { type: "keywords", patterns: ["hello"] });
      await database.prepare("UPDATE faq_entries SET user_cooldown_seconds = 120 WHERE faq_id = 'faq-hello'").run();
      const db = database as unknown as D1Database;
      const entry = (await createFaqRepository(db).matchers("channel-a"))[0]?.entry;
      if (entry === undefined) throw new Error("The seeded FAQ entry is missing.");

      expect(FAQ_CLAIM_ELIGIBLE_SQL).toContain("faq_entry_user_cooldowns");
      await expect(peekClaim(db, "channel-a", entry, "dry-run:viewer_42", NOW))
        .resolves.toEqual({ claimed: true, claimedAt: NOW });
      await expect(database.prepare("SELECT last_used_at FROM faq_entries WHERE faq_id = 'faq-hello'").first())
        .resolves.toEqual({ last_used_at: null });
      await expect(createFaqRepository(db).claim("channel-a", entry, "dry-run:viewer_42", NOW))
        .resolves.toEqual({ claimed: true, claimedAt: NOW });
      await expect(peekClaim(db, "channel-a", entry, "dry-run:viewer_42", NOW))
        .resolves.toEqual({ claimed: false, reason: "person_cooldown", remainingSeconds: 120 });
    } finally {
      database.close();
    }
  });
});
