import { describe, expect, it, vi } from "vitest";

import { textCommandModule } from "../../src/modules/text_commands";
import { createTextCommandRepository } from "../../src/modules/text_commands/adapters/d1";
import { dispatchEventSubNotification } from "../../src/worker/dispatch";
import { upsertBotIdentity } from "../../src/worker/db/bot-identity";
import { encryptJson, parseKeyRing } from "../../src/worker/auth/crypto";
import { dryRunChatMessage } from "../../src/worker/dry-run";
import { insertAppAccessToken, insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

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
});
