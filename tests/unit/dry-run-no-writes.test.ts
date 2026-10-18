import { afterEach, describe, expect, it, vi } from "vitest";

import { createTextCommandRepository } from "../../src/modules/text_commands/adapters/d1";
import { dryRunChatMessage } from "../../src/worker/dry-run";
import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

const NOW = "2026-09-19T12:00:00.000Z";
const CHANNEL_ID = "kanal-a";

const snapshotTables = (database: TestD1Database): Readonly<Record<string, unknown>> => {
  const tables = database.sqlite.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as { name: string }[];
  return Object.fromEntries(tables.map(({ name }) => [
    name,
    database.sqlite.prepare(`SELECT * FROM "${name}"`).all(),
  ]));
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("dryRunChatMessage", () => {
  it("runs the text-command service without writes, cooldown changes, provider fetches, or cache fills", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const fetcher = vi.fn<typeof fetch>(() => Promise.reject(new Error("Dry-run must not fetch providers.")));
    vi.stubGlobal("fetch", fetcher);
    const database = new TestD1Database();
    try {
      await insertChannel(database, CHANNEL_ID);
      await database.prepare(
        "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'text_commands', 1, '{}')",
      ).bind(CHANNEL_ID).run();
      await database.prepare(
        "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'faq', 1, '{}')",
      ).bind(CHANNEL_ID).run();
      await database.prepare(
        `INSERT INTO bot_identity
          (id, user_id, login, scopes_json, access_token_ciphertext, refresh_token_ciphertext, expires_at, created_at, updated_at)
         VALUES (1, 'bot-user', 'brobot', '[]', 'access', 'refresh', ?, ?, ?)`,
      ).bind("2099-09-20T00:00:00.000Z", NOW, NOW).run();
      await database.prepare("UPDATE channels SET default_chat_target = 'where_asked' WHERE channel_id = ?")
        .bind(CHANNEL_ID).run();
      await database.prepare(
        "INSERT INTO channel_variables (channel_id, name, value, created_at, updated_at) VALUES (?, 'score', 41, ?, ?)",
      ).bind(CHANNEL_ID, NOW, NOW).run();
      const repository = createTextCommandRepository(
        database as unknown as D1Database,
        () => ({ sql: "AND 1 = 1", values: [] }),
      );
      await repository.create({
        channelId: CHANNEL_ID,
        name: "score",
        text: "Score {var.score}: {api.status}; {currency.convert USD EUR}",
        kind: "text",
        aliases: ["points"],
        cooldownSeconds: 30,
        userCooldownSeconds: 60,
        variableAction: { name: "score", operation: "add", amount: 1 },
        responseType: "reply",
        chatTarget: "where_asked",
        now: NOW,
      }, { userId: "member-1" });
      await repository.create({
        channelId: CHANNEL_ID,
        name: "timeout",
        text: "Timeout fallback",
        kind: "timeout",
        cooldownSeconds: 0,
        timeoutAction: { minSeconds: 20, maxSeconds: 60, fallbackText: "Timeout unavailable" },
        now: NOW,
      }, { userId: "member-1" });
      await repository.create({
        channelId: CHANNEL_ID,
        name: "shout",
        text: "Shoutout {target}",
        kind: "shoutout",
        cooldownSeconds: 0,
        now: NOW,
      }, { userId: "member-1" });
      await database.prepare(
        `INSERT INTO api_sources (channel_id, source_name, url, expression, revision, created_at, updated_at)
         VALUES (?, 'status', 'https://provider.example/status', '$.status', 1, ?, ?)`,
      ).bind(CHANNEL_ID, NOW, NOW).run();
      await database.prepare(
        `INSERT INTO faq_entries (faq_id, channel_id, name, matcher_json, answer_text, created_at, updated_at)
         VALUES ('faq-status', ?, 'Status', '{"type":"keywords","patterns":["status"]}', 'Online', ?, ?)`,
      ).bind(CHANNEL_ID, NOW, NOW).run();

      const before = snapshotTables(database);
      const environment = {
        DB: database as unknown as D1Database,
        PUBLIC_ORIGIN: "https://brobot.example",
      } as unknown as Env;
      const request = {
        text: "!points 10",
        sender: { login: "viewer_42", statuses: [] },
        streamState: "online",
        game: null,
        sharedChat: true,
      } as const;

      const first = await dryRunChatMessage(environment, CHANNEL_ID, request, fetcher);
      const second = await dryRunChatMessage(environment, CHANNEL_ID, request, fetcher);
      const faqRequest = { ...request, text: "status", only: { moduleId: "faq" as const, entryId: "faq-status" } };
      const firstFaq = await dryRunChatMessage(environment, CHANNEL_ID, faqRequest, fetcher);
      const secondFaq = await dryRunChatMessage(environment, CHANNEL_ID, faqRequest, fetcher);

      expect(first.modules.find(({ moduleId }) => moduleId === "text_commands")?.entries[0]).toMatchObject({
        entry: { id: "score" },
        outcome: "fires",
        match: { kind: "alias", token: "points" },
        effects: [
          { kind: "chat", target: "where_asked", postsTo: "all_shared_chats", reply: true },
          { kind: "variable", name: "score", from: 41, to: 42 },
          { kind: "cooldown", scope: "global", seconds: 30 },
          { kind: "cooldown", scope: "user", seconds: 60 },
        ],
      });
      expect(first.sender).toMatchObject({ resolved: false, perUserCooldownsUseSyntheticId: true });
      expect(first.sender.userId).toMatch(/^dry-run:/u);
      expect(firstFaq.modules.find(({ moduleId }) => moduleId === "faq")?.entries[0]).toMatchObject({
        entry: { id: "faq-status" },
        outcome: "fires",
        match: { kind: "keyword", pattern: "status" },
      });
      expect(second.modules).toEqual(first.modules);
      expect(secondFaq.modules).toEqual(firstFaq.modules);
      expect(snapshotTables(database)).toEqual(before);
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });
});
