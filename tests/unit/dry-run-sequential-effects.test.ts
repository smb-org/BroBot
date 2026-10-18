import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_VOTEKICK_SETTINGS } from "../../src/modules/votekick/contracts";
import { votekickModule } from "../../src/modules/votekick";
import { faqModule } from "../../src/modules/faq";
import { textCommandModule } from "../../src/modules/text_commands";
import { createTextCommandRepository } from "../../src/modules/text_commands/adapters/d1";
import { dryRunChatMessage } from "../../src/worker/dry-run";
import { encryptJson, parseKeyRing } from "../../src/worker/auth/crypto";
import { upsertBotIdentity } from "../../src/worker/db/bot-identity";
import { insertAppAccessToken, insertChannel, insertLoginIdentityAndSession } from "./fixtures";
import { TestD1Database } from "./test-d1";

const CHANNEL_ID = "sequential-effects-channel";
const NOW = "2026-10-19T12:00:00.000Z";
const KEY_RING = JSON.stringify({
  active: { id: "test-key", key: Buffer.from(new Uint8Array(32).fill(5)).toString("base64url") },
  retired: [],
});

const encryptedToken = (token: string) => encryptJson({ token }, parseKeyRing(KEY_RING));

const seedIdentity = async (database: TestD1Database): Promise<void> => {
  await upsertBotIdentity(database as unknown as D1Database, {
    id: 1,
    userId: "bot-user",
    login: "brobot",
    scopesJson: "[]",
    accessTokenCiphertext: await encryptedToken("bot-token"),
    refreshTokenCiphertext: await encryptedToken("bot-refresh-token"),
    expiresAt: "2099-10-19T12:00:00.000Z",
    createdAt: NOW,
    updatedAt: NOW,
  });
  await insertAppAccessToken(
    database,
    await encryptedToken("app-token"),
    "2099-10-19T12:00:00.000Z",
    NOW,
    NOW,
  );
  await insertLoginIdentityAndSession(database, CHANNEL_ID, ["moderation:read"]);
  await database.prepare(
    "UPDATE twitch_login_identity SET access_token_ciphertext = ?, refresh_token_ciphertext = ? WHERE user_id = ?",
  ).bind(await encryptedToken("broadcaster-token"), await encryptedToken("broadcaster-refresh-token"), CHANNEL_ID).run();
};

const createScenario = async (withFaq: boolean) => {
  const database = new TestD1Database();
  await insertChannel(database, CHANNEL_ID);
  await seedIdentity(database);
  await database.prepare(
    "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'text_commands', 1, '{}')",
  ).bind(CHANNEL_ID).run();
  if (withFaq) {
    await database.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'faq', 1, '{}')",
    ).bind(CHANNEL_ID).run();
    await database.prepare(
      `INSERT INTO faq_entries
        (faq_id, channel_id, name, enabled, matcher_type, matcher_json, answer_text, minimum_tier,
         cooldown_seconds, user_cooldown_seconds, games_json, chat_target, use_channel_default_target,
         sort_order, revision, last_used_at, created_at, updated_at)
       VALUES ('faq-votekick', ?, 'Votekick FAQ', 1, 'keywords', ?, 'Score {var.score}', 'everyone',
         30, 0, '[]', 'where_asked', 1, 0, 1, NULL, ?, ?)`,
    ).bind(CHANNEL_ID, JSON.stringify({ type: "keywords", patterns: ["votekick"] }), NOW, NOW).run();
  }
  await database.prepare(
    "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'votekick', 1, ?)",
  ).bind(CHANNEL_ID, JSON.stringify({
    ...DEFAULT_VOTEKICK_SETTINGS,
    starterMinRole: "vip",
    minNetVotes: 3,
    percent: 5,
    startText: "Kick start, score {var.score}",
  })).run();
  await database.prepare(
    "INSERT INTO channel_variables (channel_id, name, value, created_at, updated_at) VALUES (?, 'score', 41, ?, ?)",
  ).bind(CHANNEL_ID, NOW, NOW).run();

  const commands = createTextCommandRepository(
    database as unknown as D1Database,
    () => ({ sql: "AND 1 = 1", values: [] }),
  );
  await commands.create({
    channelId: CHANNEL_ID,
    name: "votekick",
    text: "Score {var.score}",
    kind: "text",
    cooldownSeconds: 0,
    variableAction: { name: "score", operation: "add", amount: 1 },
    now: NOW,
  }, { userId: "operator-user" });

  const targetActivity = {
    firstSeenAt: "2026-10-19T11:59:00.000Z",
    lastSeenAt: "2026-10-19T11:59:00.000Z",
  };
  const channelObject = {
    getActiveChatterCountSnapshot: vi.fn().mockResolvedValue(1),
    getActiveChatterSnapshot: vi.fn((userId: string) => Promise.resolve(userId === "target-user" ? targetActivity : null)),
    readBallotDryRunSnapshot: vi.fn().mockResolvedValue(null),
    hasOpenBallotSnapshot: vi.fn().mockResolvedValue(false),
  };
  const env = {
    DB: database as unknown as D1Database,
    PUBLIC_ORIGIN: "https://brobot.example",
    TWITCH_CLIENT_ID: "client-id",
    TWITCH_CLIENT_SECRET: "client-secret",
    TOKEN_ENCRYPTION_KEYS: KEY_RING,
    SESSION_ENCRYPTION_KEYS: KEY_RING,
    CHANNEL: {
      idFromName: (channelId: string) => channelId,
      get: () => channelObject,
    } as unknown as Env["CHANNEL"],
  } as Env;
  const fetcher = vi.fn<typeof fetch>((input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === "/helix/users") {
      return Promise.resolve(new Response(JSON.stringify({ data: [{ id: "target-user", login: "target", display_name: "target" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    }
    if (url.pathname === "/helix/moderation/moderators") {
      return Promise.resolve(new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    }
    throw new Error(`Unexpected Twitch request: ${url.pathname}`);
  });

  return { database, env, fetcher };
};

const request = {
  text: "!votekick target",
  sender: { login: "viewer_42", statuses: ["vip"] as const },
  streamState: "online" as const,
  game: null,
  sharedChat: false,
};

afterEach(() => {
  vi.useRealTimers();
});

describe("dry-run sequential module effects", () => {
  it("renders a later votekick reply with the earlier text command's simulated variable change", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const { database, env, fetcher } = await createScenario(false);
    try {
      const result = await dryRunChatMessage(env, CHANNEL_ID, request, fetcher, [textCommandModule, votekickModule]);
      const commandEntry = result.modules.find(({ moduleId }) => moduleId === "text_commands")?.entries[0];
      const votekickEntry = result.modules.find(({ moduleId }) => moduleId === "votekick")?.entries[0];

      expect(commandEntry?.effects).toContainEqual(expect.objectContaining({ kind: "chat", text: "Score 42" }));
      expect(commandEntry?.effects).toContainEqual({ kind: "variable", name: "score", from: 41, to: 42 });
      expect(votekickEntry?.effects).toContainEqual(expect.objectContaining({ kind: "chat", text: "Kick start, score 42" }));
      await expect(database.prepare("SELECT value FROM channel_variables WHERE channel_id = ? AND name = 'score'")
        .bind(CHANNEL_ID).first()).resolves.toEqual({ value: 41 });
      await expect(database.prepare("SELECT COUNT(*) AS count FROM votekicks WHERE channel_id = ?")
        .bind(CHANNEL_ID).first()).resolves.toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("exposes the earlier text-command projection to the FAQ adapter for the same command message", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const { database, env, fetcher } = await createScenario(true);
    let faqReadScore: number | undefined;
    const faqWithReadProbe: typeof faqModule = {
      ...faqModule,
      dryRunChatMessage: async (event, context) => {
        faqReadScore = (await context.readChannelVariables(["score"])).score;
        return await faqModule.dryRunChatMessage?.(event, context) ?? [];
      },
    };
    try {
      const result = await dryRunChatMessage(env, CHANNEL_ID, request, fetcher, [textCommandModule, faqWithReadProbe]);
      const commandEntry = result.modules.find(({ moduleId }) => moduleId === "text_commands")?.entries[0];
      const faqEntry = result.modules.find(({ moduleId }) => moduleId === "faq")?.entries[0];

      expect(commandEntry?.effects).toContainEqual({ kind: "variable", name: "score", from: 41, to: 42 });
      expect(faqReadScore).toBe(42);
      expect(faqEntry).toMatchObject({ outcome: "blocked", blocks: [{ code: "faq.command_prefix" }] });
      await expect(database.prepare("SELECT value FROM channel_variables WHERE channel_id = ? AND name = 'score'")
        .bind(CHANNEL_ID).first()).resolves.toEqual({ value: 41 });
    } finally {
      database.close();
    }
  });
});
