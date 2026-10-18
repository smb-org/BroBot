import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { BotModule } from "../../src/modules/contract";
import { faqModule } from "../../src/modules/faq";
import { textLibraryModule } from "../../src/modules/text_library";
import { textCommandModule } from "../../src/modules/text_commands";
import { createTextCommandRepository } from "../../src/modules/text_commands/adapters/d1";
import { dispatchEventSubNotification } from "../../src/worker/dispatch";
import { upsertBotIdentity } from "../../src/worker/db/bot-identity";
import { encryptJson, parseKeyRing } from "../../src/worker/auth/crypto";
import { dryRunChatMessage } from "../../src/worker/dry-run";
import { insertAppAccessToken, insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

vi.mock("../../src/modules/registry", async () => {
  const { textLibraryModule: templateProvider } = await import("../../src/modules/text_library");
  return {
    MODULES: [templateProvider],
    templateVariableGroupForModule: () => undefined,
    validateModuleTemplateVariable: () => undefined,
    variablesForModuleTemplateContext: (_module: unknown, variables: readonly unknown[]) => variables,
  };
});

const CHANNEL_ID = "kanal-a";
const NOW = "2026-09-19T12:00:00.000Z";
const keyRing = JSON.stringify({
  active: { id: "test-key", key: Buffer.from(new Uint8Array(32).fill(5)).toString("base64url") },
  retired: [],
});

const environmentFor = (database: TestD1Database) => {
  const channelObject = {
    publish: vi.fn().mockResolvedValue(undefined),
    recordChatActivity: vi.fn().mockResolvedValue(0),
    clearActiveChatters: vi.fn().mockResolvedValue(undefined),
    getActiveChatterCount: vi.fn().mockResolvedValue(0),
    getActiveChatter: vi.fn().mockResolvedValue(null),
    claimAutomatedChatOutput: vi.fn().mockResolvedValue(true),
    recordBotChatMessage: vi.fn().mockResolvedValue(undefined),
    isRecentBotChatMessage: vi.fn().mockResolvedValue(false),
    getChatActivityCount: vi.fn().mockResolvedValue(0),
    getTwitchRateLimitRetryAfter: vi.fn().mockResolvedValue(null),
    setTwitchRateLimitRetryAfter: vi.fn().mockResolvedValue(undefined),
    scheduleModuleAlarm: vi.fn().mockResolvedValue(undefined),
    clearModuleAlarm: vi.fn().mockResolvedValue(undefined),
    getModuleAlarmDeadline: vi.fn().mockResolvedValue(null),
    getModuleAlarmPlan: vi.fn().mockResolvedValue(null),
  };
  return {
    DB: database as unknown as D1Database,
    TWITCH_CLIENT_ID: "client-id",
    TWITCH_CLIENT_SECRET: "client-secret",
    TOKEN_ENCRYPTION_KEYS: keyRing,
    PUBLIC_ORIGIN: "https://brobot.example",
    CHANNEL: {
      idFromName: (channelId: string) => channelId,
      get: () => channelObject,
    } as unknown as Env["CHANNEL"],
  };
};

const sent = () => vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
  data: [{ is_sent: true, message_id: "message-sent" }],
}), { status: 200, headers: { "content-type": "application/json" } }));

const urlFor = (input: RequestInfo | URL): string =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

const seedChannelAndCommand = async (database: TestD1Database): Promise<void> => {
  await insertChannel(database, CHANNEL_ID);
  await database.prepare(
    "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'text_commands', 1, '{}')",
  ).bind(CHANNEL_ID).run();
  const repository = createTextCommandRepository(
    database as unknown as D1Database,
    () => ({ sql: "AND 1 = 1", values: [] }),
  );
  await repository.create({
    channelId: CHANNEL_ID,
    name: "hello",
    text: "Hello {target}",
    kind: "text",
    aliases: ["hi"],
    cooldownSeconds: 30,
    responseType: "say",
    chatTarget: "where_asked",
    now: NOW,
  }, { userId: "member-1" });
};

const seedUsageCommand = async (
  database: TestD1Database,
  controls: { disabled?: boolean; paused?: boolean } = {},
): Promise<void> => {
  await insertChannel(database, CHANNEL_ID);
  await database.prepare(
    "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'text_commands', ?, '{}')",
  ).bind(CHANNEL_ID, controls.disabled === true ? 0 : 1).run();
  if (controls.paused === true) {
    await database.prepare("INSERT INTO channel_controls (channel_id, paused, updated_at) VALUES (?, 1, ?)")
      .bind(CHANNEL_ID, NOW).run();
  }
  const repository = createTextCommandRepository(
    database as unknown as D1Database,
    () => ({ sql: "AND 1 = 1", values: [] }),
  );
  await repository.create({
    channelId: CHANNEL_ID,
    name: "shout",
    text: "Visit {target}",
    kind: "shoutout",
    usageText: "Usage: !shout <name>",
    cooldownSeconds: 30,
    userCooldownSeconds: 60,
    responseType: "reply",
    chatTarget: "source_only",
    now: NOW,
  }, { userId: "member-1" });
};

const chatEventFor = (text: string, triggerId: string) => ({
  channelId: CHANNEL_ID,
  subscriptionType: "channel.chat.message",
  triggerId,
  payload: {
    message: { text },
    message_id: `message-${triggerId}`,
    chatter_user_id: "viewer-42",
    chatter_user_login: "viewer_42",
    broadcaster_user_login: CHANNEL_ID,
    source_broadcaster_user_id: CHANNEL_ID,
    badges: [],
  },
  receivedAt: NOW,
});

const seedBotIdentity = async (database: TestD1Database): Promise<void> => {
  await upsertBotIdentity(database as unknown as D1Database, {
    id: 1,
    userId: "bot-1",
    login: "brobot",
    scopesJson: "[]",
    accessTokenCiphertext: await encryptJson({ token: "bot-token" }, parseKeyRing(keyRing)),
    refreshTokenCiphertext: await encryptJson({ token: "refresh-token" }, parseKeyRing(keyRing)),
    expiresAt: "2099-09-20T00:00:00.000Z",
    createdAt: NOW,
    updatedAt: NOW,
  });
  await insertAppAccessToken(
    database,
    await encryptJson({ token: "app-token" }, parseKeyRing(keyRing)),
    "2099-09-21T00:00:00.000Z",
    NOW,
    NOW,
  );
};

const seedFaqAnswer = async (
  database: TestD1Database,
  faqId: string,
  trigger: string,
  answerText: string,
  order = 0,
): Promise<void> => {
  await database.prepare(
    `INSERT INTO faq_entries
      (faq_id, channel_id, name, enabled, matcher_type, matcher_json, answer_text, minimum_tier,
       cooldown_seconds, user_cooldown_seconds, games_json, chat_target, use_channel_default_target,
       sort_order, revision, last_used_at, created_at, updated_at)
     VALUES (?, ?, ?, 1, 'keywords', ?, ?, 'everyone', 30, 0, '[]', 'where_asked', 1, ?, 1, NULL, ?, ?)`,
  ).bind(
    faqId,
    CHANNEL_ID,
    faqId,
    JSON.stringify({ type: "keywords", patterns: [trigger] }),
    answerText,
    order,
    NOW,
    NOW,
  ).run();
};

const seedTextBlock = async (
  database: TestD1Database,
  blockName: string,
  variants: readonly { id: string; conditions: Readonly<Record<string, unknown>>; texts: readonly string[] }[],
): Promise<void> => {
  await database.prepare("INSERT INTO text_library_settings (channel_id, graph_revision, updated_at) VALUES (?, 1, ?)")
    .bind(CHANNEL_ID, NOW).run();
  await database.prepare("INSERT INTO text_library_categories (channel_id, category_id, created_at, updated_at) VALUES (?, 'faq', ?, ?)")
    .bind(CHANNEL_ID, NOW, NOW).run();
  await database.prepare("INSERT INTO text_blocks (channel_id, block_name, category_id, revision, created_at, updated_at) VALUES (?, ?, 'faq', 1, ?, ?)")
    .bind(CHANNEL_ID, blockName, NOW, NOW).run();
  for (const [position, variant] of variants.entries()) {
    await database.prepare(
      "INSERT INTO text_block_variants (channel_id, block_name, variant_id, position, conditions_json, texts_json) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(CHANNEL_ID, blockName, variant.id, position, JSON.stringify(variant.conditions), JSON.stringify(variant.texts)).run();
  }
};

describe("text-command dry-run parity", () => {
  it("matches production alias diagnostics, rendered reply, and shared-chat target without consuming the dry-run seed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const productionDatabase = new TestD1Database();
    const dryRunDatabase = new TestD1Database();
    try {
      await Promise.all([
        seedChannelAndCommand(productionDatabase),
        seedChannelAndCommand(dryRunDatabase),
      ]);
      await seedBotIdentity(productionDatabase);
      const productionFetcher = sent();
      await dispatchEventSubNotification(environmentFor(productionDatabase), {
        channelId: CHANNEL_ID,
        subscriptionType: "channel.chat.message",
        triggerId: "production-message",
        payload: {
          message: { text: "!hi" },
          message_id: "incoming-message",
          chatter_user_id: "dry-run:viewer_42",
          chatter_user_login: "viewer_42",
          broadcaster_user_login: CHANNEL_ID,
          source_broadcaster_user_id: CHANNEL_ID,
          badges: [],
        },
        receivedAt: NOW,
      }, productionFetcher, [textCommandModule]);
      const productionLogs = await productionDatabase.prepare(
        "SELECT code, detail_json FROM event_log WHERE module_id = 'text_commands' ORDER BY rowid",
      ).all<{ code: string; detail_json: string }>();

      const result = await dryRunChatMessage(
        { ...environmentFor(dryRunDatabase), DB: dryRunDatabase as unknown as D1Database } as unknown as Env,
        CHANNEL_ID,
        {
          text: "!hi",
          sender: { login: "viewer_42", statuses: [] },
          streamState: "online",
          game: null,
          sharedChat: false,
          only: { moduleId: "text_commands" },
        },
        vi.fn<typeof fetch>(),
        [textCommandModule],
      );
      const entry = result.modules[0]?.entries[0];
      const trigger = productionLogs.results.find(({ code }) => code === "text_commands.triggered");
      const sentRequest = productionFetcher.mock.calls.find(([input]) => urlFor(input).endsWith("/chat/messages"));
      const sentBody = typeof sentRequest?.[1]?.body === "string"
        ? JSON.parse(sentRequest[1].body) as Record<string, unknown>
        : {};

      expect(trigger).toBeDefined();
      expect(JSON.parse(trigger?.detail_json ?? "{}")).toMatchObject({ alias: "hi", response: "Hello viewer_42" });
      expect(sentBody).toMatchObject({ message: "Hello viewer_42", for_source_only: true });
      expect(entry?.outcome).toBe("fires");
      expect(entry?.match).toEqual({ kind: "alias", token: "hi" });
      expect(entry?.effects.some((effect) => effect.kind === "chat" && effect.text === "Hello viewer_42" &&
        effect.target === "where_asked" && effect.postsTo === "this_chat")).toBe(true);
      expect(entry?.effects.some((effect) => effect.kind === "cooldown" && effect.scope === "global" && effect.seconds === 30))
        .toBe(true);
      await expect(dryRunDatabase.prepare("SELECT use_count, last_used_at FROM text_commands WHERE command_name = 'hello'").first())
        .resolves.toEqual({ use_count: 0, last_used_at: null });
    } finally {
      productionDatabase.close();
      dryRunDatabase.close();
      vi.useRealTimers();
    }
  });

  it("reports FAQ fires only when the production service claims and uses the synthetic sender for cooldowns", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const productionDatabase = new TestD1Database();
    const dryRunDatabase = new TestD1Database();
    try {
      for (const database of [productionDatabase, dryRunDatabase]) {
        await insertChannel(database, CHANNEL_ID);
        await database.prepare(
          "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'faq', 1, '{}')",
        ).bind(CHANNEL_ID).run();
        await database.prepare(
          `INSERT INTO faq_entries
            (faq_id, channel_id, name, enabled, matcher_type, matcher_json, answer_text, minimum_tier,
             cooldown_seconds, user_cooldown_seconds, games_json, chat_target, use_channel_default_target,
             sort_order, revision, last_used_at, created_at, updated_at)
           VALUES
            ('faq-hello', ?, 'Greeting', 1, 'keywords', '{"type":"keywords","patterns":["hello"]}', 'Hello!',
             'everyone', 30, 120, '[]', 'where_asked', 1, 0, 1, NULL, ?, ?),
            ('faq-later', ?, 'Later match', 1, 'regex', '{"type":"regex","pattern":"hello"}', 'Later!',
             'everyone', 30, 0, '[]', 'where_asked', 1, 1, 1, NULL, ?, ?)`,
        ).bind(CHANNEL_ID, NOW, NOW, CHANNEL_ID, NOW, NOW).run();
      }
      await Promise.all([seedBotIdentity(productionDatabase), seedBotIdentity(dryRunDatabase)]);
      const request = {
        text: "🎉 hello",
        sender: { login: "viewer_42", statuses: [] },
        streamState: "online" as const,
        game: null,
        sharedChat: false,
        only: { moduleId: "faq" as const },
      };
      const dryRunEnvironment = {
        ...environmentFor(dryRunDatabase),
        DB: dryRunDatabase as unknown as D1Database,
      } as unknown as Env;
      const dryRunFirst = await dryRunChatMessage(dryRunEnvironment, CHANNEL_ID, request, vi.fn<typeof fetch>(), [faqModule]);
      const productionFetcher = sent();
      const productionEvent = (triggerId: string) => ({
        channelId: CHANNEL_ID,
        subscriptionType: "channel.chat.message",
        triggerId,
        payload: {
          message: { text: request.text },
          message_id: triggerId,
          chatter_user_id: "dry-run:viewer_42",
          chatter_user_login: "viewer_42",
          broadcaster_user_login: CHANNEL_ID,
          source_broadcaster_user_id: CHANNEL_ID,
          badges: [],
        },
        receivedAt: NOW,
      });
      await dispatchEventSubNotification(environmentFor(productionDatabase), productionEvent("production-first"), productionFetcher, [faqModule]);
      const firstClaim = await productionDatabase.prepare(
        "SELECT last_used_at FROM faq_entries WHERE faq_id = 'faq-hello'",
      ).first<{ last_used_at: string | null }>();
      const firstOutcome = dryRunFirst.modules[0]?.entries.find(({ entry }) => entry.id === "faq-hello")?.outcome;

      expect(firstClaim?.last_used_at).toBe(NOW);
      expect(firstOutcome).toBe("fires");
      expect(dryRunFirst.modules[0]?.entries.find(({ entry }) => entry.id === "faq-later")).toMatchObject({
        outcome: "blocked",
        blocks: [{ code: "faq.shadowed", detail: { byEntryId: "faq-hello" } }],
      });
      const onlyShadowed = await dryRunChatMessage(
        dryRunEnvironment,
        CHANNEL_ID,
        { ...request, only: { moduleId: "faq", entryId: "faq-later" } },
        vi.fn<typeof fetch>(),
        [faqModule],
      );
      expect(onlyShadowed.modules[0]?.entries).toHaveLength(1);
      expect(onlyShadowed.modules[0]?.entries[0]?.entry.id).toBe("faq-later");

      await dispatchEventSubNotification(environmentFor(productionDatabase), productionEvent("production-second"), productionFetcher, [faqModule]);
      const secondClaim = await productionDatabase.prepare(
        "SELECT user_id, last_used_at FROM faq_entry_user_cooldowns WHERE faq_id = 'faq-hello'",
      ).first<{ user_id: string; last_used_at: string }>();
      await dryRunDatabase.prepare("UPDATE faq_entries SET last_used_at = ? WHERE faq_id = 'faq-hello'")
        .bind(firstClaim?.last_used_at ?? NOW).run();
      await dryRunDatabase.prepare(
        `INSERT INTO faq_entry_user_cooldowns (channel_id, faq_id, user_id, last_used_at) VALUES (?, 'faq-hello', ?, ?)`,
      ).bind(CHANNEL_ID, secondClaim?.user_id ?? "dry-run:viewer_42", secondClaim?.last_used_at ?? NOW).run();
      const dryRunSecond = await dryRunChatMessage(dryRunEnvironment, CHANNEL_ID, request, vi.fn<typeof fetch>(), [faqModule]);
      const secondOutcome = dryRunSecond.modules[0]?.entries.find(({ entry }) => entry.id === "faq-hello");

      expect(secondClaim).toEqual({ user_id: "dry-run:viewer_42", last_used_at: NOW });
      expect(productionFetcher.mock.calls.filter(([input]) => urlFor(input).endsWith("/chat/messages"))).toHaveLength(1);
      expect(secondOutcome).toMatchObject({
        outcome: "blocked",
        blocks: [{ code: "faq.person_cooldown", detail: { remainingSeconds: 120 } }],
        effects: [],
      });
    } finally {
      productionDatabase.close();
      dryRunDatabase.close();
      vi.useRealTimers();
    }
  });

  it("uses the FAQ production template context for moderator-conditioned answer blocks", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const productionDatabase = new TestD1Database();
    const dryRunDatabase = new TestD1Database();
    try {
      for (const database of [productionDatabase, dryRunDatabase]) {
        await insertChannel(database, CHANNEL_ID);
        await database.prepare(
          "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'faq', 1, '{}')",
        ).bind(CHANNEL_ID).run();
        await seedFaqAnswer(database, "faq-moderator", "hello", "{text.answer}");
        await seedTextBlock(database, "answer", [
          { id: "moderator", conditions: { minimumTier: "moderator" }, texts: ["Moderator answer"] },
          { id: "fallback", conditions: {}, texts: [""] },
        ]);
      }
      await Promise.all([seedBotIdentity(productionDatabase), seedBotIdentity(dryRunDatabase)]);

      const productionFetcher = sent();
      await dispatchEventSubNotification(environmentFor(productionDatabase), {
        channelId: CHANNEL_ID,
        subscriptionType: "channel.chat.message",
        triggerId: "production-moderator-message",
        payload: {
          message: { text: "hello" },
          message_id: "production-moderator-message",
          chatter_user_id: "viewer-1",
          chatter_user_login: "viewer_1",
          broadcaster_user_login: CHANNEL_ID,
          source_broadcaster_user_id: CHANNEL_ID,
          badges: [{ set_id: "moderator", id: "1", info: "" }],
        },
        receivedAt: NOW,
      }, productionFetcher, [faqModule, textLibraryModule]);
      const dryRun = await dryRunChatMessage(
        { ...environmentFor(dryRunDatabase), DB: dryRunDatabase as unknown as D1Database } as unknown as Env,
        CHANNEL_ID,
        {
          text: "hello",
          sender: { login: "viewer_1", statuses: ["moderator"] },
          streamState: "online",
          game: null,
          sharedChat: false,
          only: { moduleId: "faq" },
        },
        vi.fn<typeof fetch>(),
        [faqModule, textLibraryModule],
      );
      const productionClaim = await productionDatabase.prepare(
        "SELECT last_used_at FROM faq_entries WHERE faq_id = 'faq-moderator'",
      ).first<{ last_used_at: string | null }>();
      const dryRunClaim = await dryRunDatabase.prepare(
        "SELECT last_used_at FROM faq_entries WHERE faq_id = 'faq-moderator'",
      ).first<{ last_used_at: string | null }>();

      expect(productionClaim?.last_used_at).toBeNull();
      expect(dryRunClaim?.last_used_at).toBeNull();
      expect(productionFetcher.mock.calls.filter(([input]) => urlFor(input).endsWith("/chat/messages"))).toHaveLength(0);
      expect(dryRun.modules[0]?.entries[0]).toMatchObject({ outcome: "blocked", effects: [], templateNotes: [] });
    } finally {
      productionDatabase.close();
      dryRunDatabase.close();
      vi.useRealTimers();
    }
  });

  it("samples multi-text FAQ answers read-only and reports unavailable text blocks", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const database = new TestD1Database();
    try {
      await insertChannel(database, CHANNEL_ID);
      await database.prepare(
        "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'faq', 1, '{}')",
      ).bind(CHANNEL_ID).run();
      await seedFaqAnswer(database, "faq-multiple", "hello", "{text.answer}");
      await seedFaqAnswer(database, "faq-missing", "missing", "{text.unavailable}", 1);
      await seedTextBlock(database, "answer", [
        { id: "default", conditions: {}, texts: ["Answer A", "Answer B"] },
      ]);
      await seedBotIdentity(database);

      const environment = { ...environmentFor(database), DB: database as unknown as D1Database } as unknown as Env;
      const multiText = await dryRunChatMessage(environment, CHANNEL_ID, {
        text: "hello",
        sender: { login: "viewer_1", statuses: [] },
        streamState: "online",
        game: null,
        sharedChat: false,
        only: { moduleId: "faq", entryId: "faq-multiple" },
      }, vi.fn<typeof fetch>(), [faqModule, textLibraryModule]);
      const multiTextEntry = multiText.modules[0]?.entries[0];
      const multiTextEffect = multiTextEntry?.effects.find((effect) => effect.kind === "chat");
      const chosenIndex = await database.prepare(
        "SELECT last_chosen_index FROM text_block_variants WHERE block_name = 'answer' AND variant_id = 'default'",
      ).first<{ last_chosen_index: number }>();
      const faqClaim = await database.prepare(
        "SELECT last_used_at FROM faq_entries WHERE faq_id = 'faq-multiple'",
      ).first<{ last_used_at: string | null }>();

      expect(multiTextEntry?.outcome).toBe("fires");
      expect(multiTextEffect).toMatchObject({ kind: "chat" });
      if (multiTextEffect?.kind !== "chat") throw new Error("Expected a rendered FAQ chat effect.");
      expect(["Answer A", "Answer B"]).toContain(multiTextEffect.text);
      expect(multiTextEffect.text).not.toContain("{text.answer}");
      expect(multiTextEntry?.templateNotes).toEqual([]);
      expect(chosenIndex?.last_chosen_index).toBe(-1);
      expect(faqClaim?.last_used_at).toBeNull();

      const missingText = await dryRunChatMessage(environment, CHANNEL_ID, {
        text: "missing",
        sender: { login: "viewer_1", statuses: [] },
        streamState: "online",
        game: null,
        sharedChat: false,
        only: { moduleId: "faq", entryId: "faq-missing" },
      }, vi.fn<typeof fetch>(), [faqModule, textLibraryModule]);

      expect(missingText.modules[0]?.entries[0]?.templateNotes).toContainEqual({
        code: "template.lookup_unavailable",
        detail: { name: "text.unavailable" },
      });
    } finally {
      database.close();
      vi.useRealTimers();
    }
  });

  it("prepares attributed FAQ answers through the host dry-run output pipeline", async () => {
    const database = new TestD1Database();
    const message = "x".repeat(495);
    const renderFaq = faqModule.dryRunChatMessage;
    if (renderFaq === undefined) throw new Error("FAQ dry-run handler is required.");
    const attributedFaqModule: BotModule = {
      ...faqModule,
      dryRunChatMessage: (event, context) => renderFaq(event, {
        ...context,
        renderTemplate: async () => ({ text: message, diagnostics: [], attributions: ["MET Norway"] }),
      }),
    };
    try {
      await insertChannel(database, CHANNEL_ID);
      await database.prepare(
        "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'faq', 1, '{}')",
      ).bind(CHANNEL_ID).run();
      await seedFaqAnswer(database, "faq-attributed", "hello", "unused");
      await seedBotIdentity(database);

      const report = await dryRunChatMessage(
        { ...environmentFor(database), DB: database as unknown as D1Database } as unknown as Env,
        CHANNEL_ID,
        {
          text: "hello",
          sender: { login: "viewer_1", statuses: [] },
          streamState: "online",
          game: null,
          sharedChat: false,
          only: { moduleId: "faq", entryId: "faq-attributed" },
        },
        vi.fn<typeof fetch>(),
        [attributedFaqModule, textLibraryModule],
      );
      const effect = report.modules[0]?.entries[0]?.effects.find((candidate) => candidate.kind === "chat");

      expect(effect).toMatchObject({
        kind: "chat",
        text: `${"x".repeat(486)}… · MET Norway`,
        postsTo: "this_chat",
        suppressedBy: null,
      });
    } finally {
      database.close();
    }
  });

  it.each([
    { state: "disabled" as const, controls: { disabled: true }, block: "host.module_disabled" },
    { state: "paused" as const, controls: { paused: true }, block: "host.channel_paused" },
  ])("lets the host $state block override a usage reply and cooldown effects", async ({ controls, block }) => {
    const productionDatabase = new TestD1Database();
    const dryRunDatabase = new TestD1Database();
    try {
      await Promise.all([
        seedUsageCommand(productionDatabase, controls),
        seedUsageCommand(dryRunDatabase, controls),
      ]);
      const productionFetcher = vi.fn<typeof fetch>();
      await dispatchEventSubNotification(environmentFor(productionDatabase), chatEventFor("!shout", `production-${block}`), productionFetcher, [textCommandModule]);
      const result = await dryRunChatMessage(
        environmentFor(dryRunDatabase) as unknown as Env,
        CHANNEL_ID,
        {
          text: "!shout",
          sender: { login: "viewer_42", statuses: [] },
          streamState: "online",
          game: null,
          sharedChat: false,
          only: { moduleId: "text_commands" },
        },
        vi.fn<typeof fetch>(),
        [textCommandModule],
      );
      const entry = result.modules[0]?.entries[0];

      expect(productionFetcher).not.toHaveBeenCalled();
      expect(entry?.outcome).toBe("blocked");
      expect(entry?.blocks.map(({ code }) => code)).toContain(block);
      expect(entry?.effects).toEqual([]);
      await expect(productionDatabase.prepare("SELECT use_count FROM text_commands WHERE command_name = 'shout'").first())
        .resolves.toEqual({ use_count: 0 });
      await expect(dryRunDatabase.prepare("SELECT use_count FROM text_commands WHERE command_name = 'shout'").first())
        .resolves.toEqual({ use_count: 0 });
    } finally {
      productionDatabase.close();
      dryRunDatabase.close();
    }
  });

  it("marks muted chat, announcement, timeout, and shoutout effects like the production host", async () => {
    const productionDatabase = new TestD1Database();
    const dryRunDatabase = new TestD1Database();
    try {
      for (const database of [productionDatabase, dryRunDatabase]) {
        await insertChannel(database, CHANNEL_ID);
        await database.prepare(
          "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'text_commands', 1, '{}')",
        ).bind(CHANNEL_ID).run();
        await database.prepare("INSERT INTO channel_controls (channel_id, muted, updated_at) VALUES (?, 1, ?)")
          .bind(CHANNEL_ID, NOW).run();
        const repository = createTextCommandRepository(
          database as unknown as D1Database,
          () => ({ sql: "AND 1 = 1", values: [] }),
        );
        await Promise.all([
          repository.create({
            channelId: CHANNEL_ID, name: "shout", text: "Visit {target}", kind: "shoutout",
            cooldownSeconds: 0, now: NOW,
          }, { userId: "member-1" }),
          repository.create({
            channelId: CHANNEL_ID, name: "timeout", text: "Timed out", kind: "timeout",
            cooldownSeconds: 0, timeoutAction: { minSeconds: 20, maxSeconds: 60, fallbackText: "Fallback" }, now: NOW,
          }, { userId: "member-1" }),
          repository.create({
            channelId: CHANNEL_ID, name: "announce", text: "Announcement", kind: "text",
            responseType: "announcement", cooldownSeconds: 0, now: NOW,
          }, { userId: "member-1" }),
        ]);
      }

      const productionFetcher = vi.fn<typeof fetch>();
      for (const [index, message] of ["!shout bob", "!timeout", "!announce"].entries()) {
        await dispatchEventSubNotification(
          environmentFor(productionDatabase),
          chatEventFor(message, `muted-production-${String(index)}`),
          productionFetcher,
          [textCommandModule],
        );
      }
      const dryRunReports = await Promise.all(["!shout bob", "!timeout", "!announce"].map((text) =>
        dryRunChatMessage(
          environmentFor(dryRunDatabase) as unknown as Env,
          CHANNEL_ID,
          {
            text,
            sender: { login: "viewer_42", statuses: [] },
            streamState: "online",
            game: null,
            sharedChat: false,
            only: { moduleId: "text_commands" },
          },
          vi.fn<typeof fetch>(),
          [textCommandModule],
        ),
      ));
      const effectKinds = dryRunReports.map((report) => report.modules[0]?.entries[0]?.effects.map((effect) => effect.kind));
      const suppressedEffects = dryRunReports.flatMap((report) => report.modules[0]?.entries[0]?.effects ?? []);
      const suppressedRows = await productionDatabase.prepare(
        "SELECT detail_json FROM event_log WHERE module_id = 'text_commands' AND code = 'host.action.suppressed' ORDER BY rowid",
      ).all<{ detail_json: string }>();

      expect(effectKinds).toEqual([["shoutout", "chat"], ["timeout", "chat", "chat"], ["announcement"]]);
      expect(suppressedEffects.every((effect) => Reflect.get(effect, "suppressedBy") === "channel_muted")).toBe(true);
      expect(suppressedRows.results.map(({ detail_json }) => JSON.parse(detail_json) as unknown)).toEqual([
        { action: "shoutout", reason: "channel_muted" },
        { action: "chat", reason: "channel_muted" },
        { action: "timeout", reason: "channel_muted" },
        { action: "announcement", reason: "channel_muted" },
      ]);
      expect(productionFetcher).not.toHaveBeenCalled();
    } finally {
      productionDatabase.close();
      dryRunDatabase.close();
    }
  });

  it("prepares attributed dry-run text with the same 500-character host limit as production", async () => {
    const productionDatabase = new TestD1Database();
    const dryRunDatabase = new TestD1Database();
    const message = "x".repeat(495);
    const attributedModule = {
      id: "prepared-output-test",
      mandatory: false,
      defaultEnabled: true,
      settingsSchema: z.object({}),
      defaultSettings: {},
      eventSubTypes: ["channel.chat.message"],
      handleEvent: () => ({ actions: [{ kind: "chat" as const, text: message, automated: false }], diagnostics: [], attributions: ["MET Norway"] }),
      dryRunChatMessage: () => [{
        moduleId: "prepared-output-test",
        entry: { kind: "text_command" as const, id: "weather", label: "!weather" },
        outcome: "fires" as const,
        match: { kind: "command_name" as const, token: "!weather" },
        blocks: [],
        effects: [{
          kind: "chat" as const,
          text: message,
          target: "source_only" as const,
          postsTo: "this_chat" as const,
          reply: false,
          suppressedBy: null,
          automated: false,
          attributions: ["MET Norway"],
        }],
        templateNotes: [],
      }],
    } as unknown as BotModule;
    try {
      await Promise.all([insertChannel(productionDatabase, CHANNEL_ID), insertChannel(dryRunDatabase, CHANNEL_ID)]);
      await Promise.all([productionDatabase, dryRunDatabase].map((database) => database.prepare(
        "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'prepared-output-test', 1, '{}')",
      ).bind(CHANNEL_ID).run()));
      await seedBotIdentity(productionDatabase);
      const productionFetcher = sent();
      await dispatchEventSubNotification(
        environmentFor(productionDatabase),
        chatEventFor("!weather", "production-prepared-output"),
        productionFetcher,
        [attributedModule],
      );
      const dryRun = await dryRunChatMessage(
        environmentFor(dryRunDatabase) as unknown as Env,
        CHANNEL_ID,
        {
          text: "!weather",
          sender: { login: "viewer_42", statuses: [] },
          streamState: "online",
          game: null,
          sharedChat: false,
        },
        vi.fn<typeof fetch>(),
        [attributedModule],
      );
      const send = productionFetcher.mock.calls.find(([input]) => urlFor(input).endsWith("/chat/messages"));
      const body = typeof send?.[1]?.body === "string" ? JSON.parse(send[1].body) as Record<string, unknown> : {};
      const reportedText = dryRun.modules[0]?.entries[0]?.effects[0]?.kind === "chat"
        ? dryRun.modules[0].entries[0].effects[0].text
        : "";
      const expected = `${"x".repeat(486)}… · MET Norway`;

      expect(body.message).toBe(expected);
      expect(reportedText).toBe(expected);
      expect(reportedText).toHaveLength(500);
    } finally {
      productionDatabase.close();
      dryRunDatabase.close();
    }
  });
});
