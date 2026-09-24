import { describe, expect, it, vi } from "vitest";

import { textCommandModule, type TextCommandKind, type TextCommandMinimumTier } from "../../src/modules/text_commands";
import { createTextCommandRepository } from "../../src/modules/text_commands/adapters/d1";
import { prepareChannelVariableChange } from "../../src/worker/db/channel-variables";
import { dispatchEventSubNotification } from "../../src/worker/dispatch";
import {
  upsertBotIdentity,
} from "../../src/worker/db/bot-identity";
import { encryptJson, parseKeyRing } from "../../src/worker/auth/crypto";
import { insertAppAccessToken, insertChannel, insertMember } from "./fixtures";
import { TestD1Database, type TestPreparedStatement } from "./test-d1";

const NOW = "2026-09-19T12:00:00.000Z";
const keyRing = JSON.stringify({
  active: { id: "aktiv", key: Buffer.from(new Uint8Array(32).fill(5)).toString("base64url") },
  retired: [],
});

const fetcherForChat = () => vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(
  new Response(JSON.stringify({ data: [{ is_sent: true, message_id: "gesendet-1" }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }),
));

const body = (fetcher: ReturnType<typeof fetcherForChat>, index: number): Record<string, unknown> => {
  const body = fetcher.mock.calls[index]?.[1]?.body;
  return typeof body === "string" ? JSON.parse(body) as Record<string, unknown> : {};
};

const requestedUrl = (input?: RequestInfo | URL): string =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input?.url ?? "";

const environment = (database: TestD1Database) => ({
  DB: database as unknown as D1Database,
  TWITCH_CLIENT_ID: "client-id",
  TWITCH_CLIENT_SECRET: "client-secret",
  TOKEN_ENCRYPTION_KEYS: keyRing,
});

const eventFor = (text: string, channelId = "kanal-a", receivedAt = NOW, triggerId = "trigger-1", badges: readonly { set_id: string }[] = []) => ({
  channelId,
  subscriptionType: "channel.chat.message",
  triggerId,
  payload: {
    message: { text },
    message_id: `chat-${triggerId}`,
    chatter_user_id: "user-1",
    chatter_user_login: "alice",
    broadcaster_user_login: channelId,
    badges,
  },
  receivedAt,
});

const activate = async (database: TestD1Database, channelId: string): Promise<void> => {
  await database.prepare(
    "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, ?, 1, '{}')",
  ).bind(channelId, textCommandModule.id).run();
};

const createCommand = async (
  database: TestD1Database,
  name = "hallo",
  minimumTier: TextCommandMinimumTier = "everyone",
  text = "Hallo {user}",
): Promise<void> => {
  const repository = createTextCommandRepository(
    database as unknown as D1Database,
    () => ({ sql: "AND 1 = 1", values: [] as const }),
  );
  await repository.create({
    channelId: "kanal-a",
    name,
    text,
    kind: "text",
    minimumTier: minimumTier,
    cooldownSeconds: 5,
    now: NOW,
  }, { userId: "user-1" });
};

const createBuiltinCommand = async (
  database: TestD1Database,
  name: string,
  kind: TextCommandKind,
  text: string,
  templates: { offlineText?: string; notFollowingText?: string; unavailableText?: string; usageText?: string; legacyFallback?: boolean; legacyKind?: "uptime" | "followage" } = {},
): Promise<void> => {
  const repository = createTextCommandRepository(
    database as unknown as D1Database,
    () => ({ sql: "AND 1 = 1", values: [] as const }),
  );
  await repository.create({
    channelId: "kanal-a", name, kind, text, cooldownSeconds: 0, now: NOW, ...templates,
  }, { userId: "user-1" });
};

const mitBot = async (database: TestD1Database): Promise<void> => {
  await upsertBotIdentity(database as unknown as D1Database, {
    id: 1,
    userId: "bot-1",
    login: "brobot",
    scopesJson: "[]",
    accessTokenCiphertext: await encryptJson({ token: "bot-token" }, parseKeyRing(keyRing)),
    refreshTokenCiphertext: await encryptJson({ token: "refresh" }, parseKeyRing(keyRing)),
    expiresAt: "2026-09-20T00:00:00.000Z",
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

const eventCodes = async (database: TestD1Database): Promise<string[]> => {
  const result = await database.prepare("SELECT code FROM event_log ORDER BY rowid").all<{ code: string }>();
  return result.results.map((entry) => entry.code);
};

describe("Text commands module", () => {
  it("does not let a same-timestamp cooldown loser undo the winning variable claim", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertMember(database, "kanal-a", "user-1", "operator");
      const repository = createTextCommandRepository(
        database as unknown as D1Database,
        () => ({ sql: "AND 1 = 1", values: [] as const }),
      );
      await database.prepare(
        `INSERT INTO channel_variables (channel_id, name, value, created_at, updated_at)
         VALUES ('kanal-a', 'score', 0, ?, ?)`,
      ).bind(NOW, NOW).run();
      await repository.create({
        channelId: "kanal-a", name: "increment", text: "Score {var.score}", kind: "text", cooldownSeconds: 60,
        variableAction: { name: "score", operation: "add", amount: 1 }, now: NOW,
      }, { userId: "user-1" });
      const knownCommand = await repository.find("kanal-a", "increment");
      if (knownCommand === null) throw new Error("Command missing before the concurrent claims.");
      const prepareChange = (channelId: string, change: Parameters<typeof prepareChannelVariableChange>[2], at: string, guard: Parameters<typeof prepareChannelVariableChange>[4]) =>
        prepareChannelVariableChange(database as unknown as D1Database, channelId, change, at, guard);

      const claims = await Promise.all([
        repository.claim("kanal-a", "increment", NOW, "user-1", 60, prepareChange, null, knownCommand),
        repository.claim("kanal-a", "increment", NOW, "user-1", 60, prepareChange, null, knownCommand),
      ]);

      expect(claims.filter((claim) => claim?.claimed)).toHaveLength(1);
      await expect(database.prepare("SELECT value FROM channel_variables WHERE name = 'score'").first())
        .resolves.toEqual({ value: 1 });
      await expect(database.prepare("SELECT last_used_at, use_count FROM text_commands WHERE command_name = 'increment'").first())
        .resolves.toEqual({ last_used_at: NOW, use_count: 1 });
      await expect(database.prepare("SELECT last_used_at FROM text_command_user_cooldowns WHERE command_name = 'increment' AND user_id = 'user-1'").first())
        .resolves.toEqual({ last_used_at: NOW });
    } finally {
      database.close();
    }
  });

  it("treats removed edit commands as unknown and doesn't change module data", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertMember(database, "kanal-a", "user-1", "operator");
      await mitBot(database);
      await activate(database, "kanal-a");
      const fetcher = fetcherForChat();

      await dispatchEventSubNotification(environment(database), eventFor("!befehl hinzufuegen foo bar", "kanal-a", NOW, "trigger-add"), fetcher, [textCommandModule]);
      await dispatchEventSubNotification(environment(database), eventFor("!befehl entfernen foo", "kanal-a", NOW, "trigger-remove"), fetcher, [textCommandModule]);

      expect(fetcher).not.toHaveBeenCalled();
      await expect(database.prepare("SELECT COUNT(*) AS count FROM text_commands").first<{ count: number }>())
        .resolves.toEqual({ count: 0 });
      await expect(eventCodes(database)).resolves.toEqual(["text_commands.unknown", "text_commands.unknown"]);
    } finally {
      database.close();
    }
  });

  it("replies only in the channel where the command was created", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertChannel(database, "kanal-b");
      await insertMember(database, "kanal-a", "user-1", "operator");
      await mitBot(database);
      await activate(database, "kanal-a");
      await activate(database, "kanal-b");
      await createCommand(database);
      const fetcher = fetcherForChat();

      await dispatchEventSubNotification(environment(database), eventFor("!hallo", "kanal-a", NOW, "trigger-2"), fetcher, [textCommandModule]);
      await dispatchEventSubNotification(environment(database), eventFor("!hallo", "kanal-b", NOW, "trigger-3"), fetcher, [textCommandModule]);

      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(body(fetcher, 0).message).toBe("Hallo alice");
      await expect(eventCodes(database)).resolves.toContain("text_commands.unknown");
    } finally {
      database.close();
    }
  });

  it("truncates an expanded chat response to 500 characters and records a diagnostic", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertMember(database, "kanal-a", "user-1", "operator");
      await mitBot(database);
      await activate(database, "kanal-a");
      await createCommand(database, "lang", "everyone", `${"x".repeat(500)}{legacy}`);
      const fetcher = fetcherForChat();

      await dispatchEventSubNotification(
        environment(database),
        eventFor("!lang"),
        fetcher,
        [textCommandModule],
      );

      expect((body(fetcher, 0).message as string).length).toBe(500);
      expect(body(fetcher, 0).message).toBe(`${"x".repeat(499)}…`);
      const rows = await database.prepare(
        "SELECT code, detail_json FROM event_log ORDER BY rowid",
      ).all<{ code: string; detail_json: string }>();
      expect(rows.results.map((row) => row.code)).toEqual([
        "template_truncated",
        "text_commands.triggered",
        "host.chat.sent",
      ]);
      expect(JSON.parse(rows.results[0]?.detail_json ?? "{}")).toEqual({ current: 508 });
      expect(JSON.parse(rows.results[1]?.detail_json ?? "{}")).toMatchObject({ name: "lang" });
    } finally {
      database.close();
    }
  });

  it("keeps the plain name-hit chat path within its D1 statement budget", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertMember(database, "kanal-a", "user-1", "operator");
      await mitBot(database);
      await activate(database, "kanal-a");
      await createCommand(database);
      const preparedSql: string[] = [];
      const batchSizes: number[] = [];
      const countedDb = {
        prepare(sql: string) {
          preparedSql.push(sql);
          return database.prepare(sql);
        },
        batch(statements: TestPreparedStatement[]) {
          batchSizes.push(statements.length);
          return database.batch(statements);
        },
      } as unknown as D1Database;
      const fetcher = fetcherForChat();

      await dispatchEventSubNotification(
        { ...environment(database), DB: countedDb },
        eventFor("!hallo"),
        fetcher,
        [textCommandModule],
      );

      expect(preparedSql).toHaveLength(8);
      expect(preparedSql.filter((sql) => /(?:FROM|UPDATE) text_commands/u.test(sql))).toHaveLength(2);
      expect(preparedSql.some((sql) => sql.includes("json_each"))).toBe(false);
      expect(preparedSql.filter((sql) => sql.includes("text_command_user_cooldowns"))).toHaveLength(1);
      expect(preparedSql.find((sql) => sql.includes("text_command_user_cooldowns"))?.trimStart())
        .toMatch(/^UPDATE text_commands/u);
      expect(preparedSql.some((sql) => sql.includes("channel_stream_state"))).toBe(false);
      expect(preparedSql.some((sql) => sql.includes("channel_variables"))).toBe(false);
      expect(batchSizes).toEqual([2]);
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      database.close();
    }
  });

  it("reads only requested channel variables once and deduplicates repeated tokens", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertMember(database, "kanal-a", "user-1", "operator");
      await mitBot(database);
      await activate(database, "kanal-a");
      await database.prepare(
        `INSERT INTO channel_variables (channel_id, name, value, created_at, updated_at)
         VALUES ('kanal-a', 'score', 2, ?, ?), ('kanal-a', 'points', 5, ?, ?)`,
      ).bind(NOW, NOW, NOW, NOW).run();
      await createCommand(database, "vars", "everyone", "{var.score} {var.points} {var.score}");
      const preparedSql: string[] = [];
      const countedDb = {
        prepare(sql: string) { preparedSql.push(sql); return database.prepare(sql); },
        batch(statements: TestPreparedStatement[]) { return database.batch(statements); },
      } as unknown as D1Database;
      const fetcher = fetcherForChat();

      await dispatchEventSubNotification({ ...environment(database), DB: countedDb }, eventFor("!vars"), fetcher, [textCommandModule]);

      const variableReads = preparedSql.filter((sql) => sql.includes("FROM channel_variables") && sql.includes("SELECT name, value"));
      expect(variableReads).toHaveLength(1);
      expect(variableReads[0]).toContain("name IN (?, ?)");
      expect(body(fetcher, 0).message).toBe("2 5 2");
    } finally {
      database.close();
    }
  });

  it("does not consume command or user cooldown when the variable action updates no row", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertMember(database, "kanal-a", "user-1", "operator");
      await mitBot(database);
      await activate(database, "kanal-a");
      await database.prepare(
        `INSERT INTO channel_variables (channel_id, name, value, created_at, updated_at)
         VALUES ('kanal-a', 'score', 0, ?, ?)`,
      ).bind(NOW, NOW).run();
      const repository = createTextCommandRepository(
        database as unknown as D1Database,
        () => ({ sql: "AND 1 = 1", values: [] as const }),
      );
      await repository.create({
        channelId: "kanal-a", name: "increment", text: "", kind: "text", cooldownSeconds: 0,
        userCooldownSeconds: 60, variableAction: { name: "score", operation: "add", amount: 1 }, now: NOW,
      }, { userId: "user-1" });

      const prepare = database.prepare.bind(database);
      database.prepare = (sql) => prepare(sql.includes("UPDATE channel_variables") && sql.includes("RETURNING name, value")
        ? sql.replace("WHERE channel_id = ? AND name = ?", "WHERE channel_id = ? AND name = ? AND 1 = 0")
        : sql);
      const fetcher = fetcherForChat();

      await dispatchEventSubNotification(environment(database), eventFor("!increment"), fetcher, [textCommandModule]);

      expect(fetcher).not.toHaveBeenCalled();
      await expect(database.prepare("SELECT value FROM channel_variables WHERE name = 'score'").first())
        .resolves.toEqual({ value: 0 });
      await expect(database.prepare("SELECT use_count, last_used_at FROM text_commands WHERE command_name = 'increment'").first())
        .resolves.toEqual({ use_count: 0, last_used_at: null });
      await expect(database.prepare("SELECT COUNT(*) AS count FROM text_command_user_cooldowns WHERE command_name = 'increment'").first())
        .resolves.toEqual({ count: 0 });
      expect(await eventCodes(database)).toContain("text_commands.variable_update_failed");
      expect(await eventCodes(database)).not.toContain("text_commands.triggered");
    } finally {
      database.close();
    }
  });

  it("reloads and rechecks a command after its action is edited before claim", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertMember(database, "kanal-a", "user-1", "operator");
      await mitBot(database);
      await activate(database, "kanal-a");
      await database.prepare(
        `INSERT INTO channel_variables (channel_id, name, value, created_at, updated_at)
         VALUES ('kanal-a', 'score', 0, ?, ?), ('kanal-a', 'points', 0, ?, ?)`,
      ).bind(NOW, NOW, NOW, NOW).run();
      const repository = createTextCommandRepository(
        database as unknown as D1Database,
        () => ({ sql: "AND 1 = 1", values: [] as const }),
      );
      await repository.create({
        channelId: "kanal-a", name: "increment", text: "Score {var.score}", kind: "text", cooldownSeconds: 0,
        variableAction: { name: "score", operation: "add", amount: 1 }, now: NOW,
      }, { userId: "user-1" });
      const originalBatch = database.batch.bind(database);
      let edited = false;
      database.batch = async (statements) => {
        if (!edited) {
          edited = true;
          const current = await repository.find("kanal-a", "increment");
          if (current === null) throw new Error("Command disappeared before the claim race.");
          const change = await repository.change({
            channelId: "kanal-a", name: current.name, newName: current.name,
            text: "Points {var.points}", kind: "text", enabled: current.enabled, cooldownSeconds: 0,
            aliases: current.aliases, userCooldownSeconds: 0, streamCondition: "any", responseType: "say",
            variableAction: { name: "points", operation: "add", amount: 10 }, expectedRevision: current.revision,
            now: "2026-09-19T12:00:01.000Z",
          }, { userId: "user-1" });
          if (!change.ok) throw new Error("Concurrent command edit did not apply.");
        }
        return originalBatch(statements);
      };
      const fetcher = fetcherForChat();

      await dispatchEventSubNotification(environment(database), eventFor("!increment"), fetcher, [textCommandModule]);

      await expect(database.prepare("SELECT name, value FROM channel_variables ORDER BY name").all())
        .resolves.toMatchObject({ results: [{ name: "points", value: 10 }, { name: "score", value: 0 }] });
      await expect(database.prepare("SELECT use_count FROM text_commands WHERE command_name = 'increment'").first())
        .resolves.toEqual({ use_count: 1 });
      expect(body(fetcher, 0).message).toBe("Points 10");
    } finally {
      database.close();
    }
  });

  it("uses Helix channel data for system template variables", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertMember(database, "kanal-a", "user-1", "operator");
      await mitBot(database);
      await activate(database, "kanal-a");
      await createBuiltinCommand(database, "uptime", "text", "{channel}|{uptime}", { offlineText: "The channel is offline" });
      await createBuiltinCommand(database, "game", "text", "{game}|{title}");
      const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
        const url = requestedUrl(input);
        if (url.includes("/helix/channels?")) return Promise.resolve(new Response(JSON.stringify({ data: [{ title: "Streamtitel", game_name: "Stardew Valley" }] }), { status: 200 }));
        if (url.includes("/helix/streams?")) return Promise.resolve(new Response(JSON.stringify({ data: [{ started_at: "2026-09-19T10:00:00.000Z" }] }), { status: 200 }));
        return Promise.resolve(new Response(JSON.stringify({ data: [{ is_sent: true, message_id: "chat-1" }] }), { status: 200 }));
      });

      await dispatchEventSubNotification(environment(database), eventFor("!uptime"), fetcher, [textCommandModule]);
      await dispatchEventSubNotification(environment(database), eventFor("!game", "kanal-a", NOW, "game-trigger"), fetcher, [textCommandModule]);

      expect(fetcher.mock.calls.map(([input]) => requestedUrl(input))).toEqual(expect.arrayContaining([
        expect.stringContaining("/helix/channels?broadcaster_id=kanal-a"),
        expect.stringContaining("/helix/streams?user_id=kanal-a&type=live"),
        expect.stringContaining("/helix/chat/messages"),
      ]));
      const chatBodies = fetcher.mock.calls.flatMap(([input, init]) => {
        if (typeof init?.body !== "string") return [];
        return requestedUrl(input).includes("/helix/chat/messages") ? [JSON.parse(init.body) as Record<string, unknown>] : [];
      });
      expect(chatBodies.map((entry) => entry.message)).toEqual(expect.arrayContaining([
        "kanal-a|2 Std. 0 Min.", "Stardew Valley|Streamtitel",
      ]));
    } finally {
      database.close();
    }
  });

  it("reports an unavailable Helix-backed variable and renders its fallback value", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertMember(database, "kanal-a", "user-1", "operator");
      await mitBot(database);
      await activate(database, "kanal-a");
      await createBuiltinCommand(database, "uptime", "text", "Live for {uptime}", { offlineText: "Offline" });
      const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => Promise.resolve(
        new Response(JSON.stringify({ message: "temporary failure" }), {
          status: requestedUrl(input).includes("/helix/channels?") ? 503 : 200,
        }),
      ));

      await dispatchEventSubNotification(environment(database), eventFor("!uptime"), fetcher, [textCommandModule]);

      expect(fetcher.mock.calls).toHaveLength(2);
      expect(fetcher.mock.calls.map(([input]) => requestedUrl(input))).not.toEqual(expect.arrayContaining([expect.stringContaining("/helix/channels?")]));
      expect(body(fetcher, 1).message).toBe("Live for ?");
      expect(await eventCodes(database)).toContain("template.lookup_unavailable");
    } finally {
      database.close();
    }
  });

  it("uses a migrated fallback template when the follower lookup is unavailable", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertMember(database, "kanal-a", "user-1", "operator");
      await mitBot(database);
      await activate(database, "kanal-a");
      await createBuiltinCommand(database, "followage", "text", "{user} follows {followage}", {
        notFollowingText: "Not following", unavailableText: "Data unavailable", legacyFallback: true,
      });
      const fetcher = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(JSON.stringify({ message: "not moderator" }), { status: 403 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ is_sent: true, message_id: "chat-1" }] }), { status: 200 }));

      await dispatchEventSubNotification(environment(database), eventFor("!followage"), fetcher, [textCommandModule]);

      expect(requestedUrl(fetcher.mock.calls[0]?.[0])).toContain("/helix/channels/followers?");
      expect(requestedUrl(fetcher.mock.calls[0]?.[0])).toContain("broadcaster_id=kanal-a");
      expect(requestedUrl(fetcher.mock.calls[0]?.[0])).toContain("user_id=user-1");
      expect(requestedUrl(fetcher.mock.calls[0]?.[0])).toContain("moderator_id=bot-1");
      expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe("Bearer bot-token");
      expect(body(fetcher, 1).message).toBe("Data unavailable");
      expect(await eventCodes(database)).toContain("template.lookup_unavailable");
    } finally {
      database.close();
    }
  });

  it("replaces the complete legacy uptime reply when the stream is offline", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertMember(database, "kanal-a", "user-1", "operator");
      await mitBot(database);
      await activate(database, "kanal-a");
      await createBuiltinCommand(database, "uptime", "text", "{channel} has been live for {uptime}", {
        offlineText: "{channel} is offline", legacyFallback: true,
      });
      const fetcher = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ is_sent: true, message_id: "chat-1" }] }), { status: 200 }));

      await dispatchEventSubNotification(environment(database), eventFor("!uptime"), fetcher, [textCommandModule]);

      expect(requestedUrl(fetcher.mock.calls[0]?.[0])).toContain("/helix/streams?");
      expect(body(fetcher, 1).message).toBe("kanal-a is offline");
    } finally {
      database.close();
    }
  });

  it("replaces the complete legacy followage reply when the viewer is not following", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertMember(database, "kanal-a", "user-1", "operator");
      await mitBot(database);
      await activate(database, "kanal-a");
      await createBuiltinCommand(database, "followage", "text", "{user} follows for {followage}", {
        notFollowingText: "{user} does not follow this channel", legacyFallback: true,
      });
      const fetcher = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ is_sent: true, message_id: "chat-1" }] }), { status: 200 }));

      await dispatchEventSubNotification(environment(database), eventFor("!followage"), fetcher, [textCommandModule]);

      expect(body(fetcher, 1).message).toBe("alice does not follow this channel");
    } finally {
      database.close();
    }
  });

  it("keeps migrated uptime fallback behavior when the saved reply has no uptime token", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertMember(database, "kanal-a", "user-1", "operator");
      await mitBot(database);
      await activate(database, "kanal-a");
      await createBuiltinCommand(database, "uptime", "text", "Welcome to chat", {
        offlineText: "Actually offline", legacyFallback: true, legacyKind: "uptime",
      });
      const fetcher = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ is_sent: true, message_id: "chat-1" }] }), { status: 200 }));

      await dispatchEventSubNotification(environment(database), eventFor("!uptime"), fetcher, [textCommandModule]);

      expect(requestedUrl(fetcher.mock.calls[0]?.[0])).toContain("/helix/streams?");
      expect(body(fetcher, 1).message).toBe("Actually offline");
    } finally {
      database.close();
    }
  });

  it("keeps migrated followage fallback behavior when the saved reply has no followage token", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertMember(database, "kanal-a", "user-1", "operator");
      await mitBot(database);
      await activate(database, "kanal-a");
      await createBuiltinCommand(database, "followage", "text", "Welcome to the channel", {
        notFollowingText: "Please follow first", unavailableText: "Could not check follow status",
        legacyFallback: true, legacyKind: "followage",
      });
      const fetcher = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ is_sent: true, message_id: "chat-1" }] }), { status: 200 }));

      await dispatchEventSubNotification(environment(database), eventFor("!followage"), fetcher, [textCommandModule]);

      expect(requestedUrl(fetcher.mock.calls[0]?.[0])).toContain("/helix/channels/followers?");
      expect(body(fetcher, 1).message).toBe("Please follow first");
    } finally {
      database.close();
    }
  });

  it("fetches channel details independently for a title-only template", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertMember(database, "kanal-a", "user-1", "operator");
      await mitBot(database);
      await activate(database, "kanal-a");
      await createCommand(database, "titel", "everyone", "{title}");
      const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
        const url = requestedUrl(input);
        if (url.includes("/helix/channels?")) return Promise.resolve(new Response(JSON.stringify({ data: [{ title: "Independent", game_name: "Game" }] }), { status: 200 }));
        if (url.includes("/helix/streams?")) return Promise.resolve(new Response("broken", { status: 503 }));
        return Promise.resolve(new Response(JSON.stringify({ data: [{ is_sent: true, message_id: "chat-1" }] }), { status: 200 }));
      });

      await dispatchEventSubNotification(environment(database), eventFor("!titel"), fetcher, [textCommandModule]);

      const urls = fetcher.mock.calls.map(([input]) => requestedUrl(input));
      expect(urls.filter((url) => url.includes("/helix/channels?"))).toHaveLength(1);
      expect(urls.some((url) => url.includes("/helix/streams?"))).toBe(false);
      expect(body(fetcher, 1).message).toBe("Independent");
    } finally {
      database.close();
    }
  });

  it("resolves shoutout logins in the host, logs Twitch cooldowns, and still sends the template", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertMember(database, "kanal-a", "user-1", "operator");
      await mitBot(database);
      await activate(database, "kanal-a");
      await createBuiltinCommand(database, "so", "shoutout", "Schaut bei {target} vorbei");
      const fetcher = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "target-id", login: "streamerin", display_name: "Streamerin" }] }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ message: "cooldown" }), { status: 429 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ is_sent: true, message_id: "chat-1" }] }), { status: 200 }));

      await dispatchEventSubNotification(environment(database), eventFor("!so Streamerin"), fetcher, [textCommandModule]);

      expect(requestedUrl(fetcher.mock.calls[0]?.[0])).toContain("/helix/users?login=streamerin");
      expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe("Bearer app-token");
      expect(requestedUrl(fetcher.mock.calls[1]?.[0])).toContain("/helix/chat/shoutouts?");
      expect(requestedUrl(fetcher.mock.calls[2]?.[0])).toContain("/helix/chat/messages");
      expect(body(fetcher, 2).message).toBe("Schaut bei streamerin vorbei");
      const failure = await database.prepare("SELECT code, detail_json FROM event_log WHERE code = 'host.shoutout.failed'")
        .first<{ code: string; detail_json: string }>();
      expect(failure?.code).toBe("host.shoutout.failed");
      expect(failure?.detail_json).toContain("rate_limited");
      expect(await eventCodes(database)).toContain("host.chat.sent");
    } finally {
      database.close();
    }
  });

  it("diagnoses an unknown shoutout target and still sends the following template chat", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertMember(database, "kanal-a", "user-1", "operator");
      await mitBot(database);
      await activate(database, "kanal-a");
      await createBuiltinCommand(database, "so", "shoutout", "Schaut bei {target} vorbei", { usageText: "Nutzung: !so <name>" });
      const fetcher = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ is_sent: true, message_id: "chat-1" }] }), { status: 200 }));

      await dispatchEventSubNotification(environment(database), eventFor("!so unbekannt"), fetcher, [textCommandModule]);

      expect(requestedUrl(fetcher.mock.calls[0]?.[0])).toContain("/helix/users?login=unbekannt");
      expect(requestedUrl(fetcher.mock.calls[1]?.[0])).toContain("/helix/chat/messages");
      expect(body(fetcher, 1).message).toBe("Schaut bei unbekannt vorbei");
      const failure = await database.prepare("SELECT detail_json FROM event_log WHERE code = 'host.shoutout.failed'")
        .first<{ detail_json: string }>();
      expect(failure?.detail_json).toContain("twitch_user_not_found");
      expect(await eventCodes(database)).toContain("host.chat.sent");
    } finally {
      database.close();
    }
  });

  it("doesn't reply in chat for an unknown command", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertMember(database, "kanal-a", "user-1", "operator");
      await mitBot(database);
      await activate(database, "kanal-a");
      const fetcher = fetcherForChat();

      await dispatchEventSubNotification(environment(database), eventFor("!unbekannt"), fetcher, [textCommandModule]);

      expect(fetcher).not.toHaveBeenCalled();
      await expect(eventCodes(database)).resolves.toEqual(["text_commands.unknown"]);
    } finally {
      database.close();
    }
  });

  it("loads an unknown stream as online from Helix and stores the result", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertMember(database, "kanal-a", "user-1", "operator");
      await mitBot(database);
      await activate(database, "kanal-a");
      await createCommand(database);
      await database.prepare("UPDATE text_commands SET stream_condition = 'online' WHERE command_name = 'hallo'").run();
      const fetcher = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "stream-1" }] }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ is_sent: true, message_id: "chat-1" }] }), { status: 200 }));

      await dispatchEventSubNotification(environment(database), eventFor("!hallo"), fetcher, [textCommandModule]);

      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(requestedUrl(fetcher.mock.calls[0]?.[0])).toContain("/helix/streams?");
      expect(requestedUrl(fetcher.mock.calls[1]?.[0])).toContain("/helix/chat/messages");
      await expect(database.prepare(
        "SELECT state, source FROM channel_stream_state WHERE channel_id = 'kanal-a'",
      ).first()).resolves.toEqual({ state: "online", source: "helix" });
      const diagnostics = await database.prepare("SELECT code, detail_json FROM event_log ORDER BY rowid")
        .all<{ code: string; detail_json: string }>();
      expect(diagnostics.results[0]?.code).toBe("text_commands.triggered");
      expect(JSON.parse(diagnostics.results[0]?.detail_json ?? "{}")).toMatchObject({
        name: "hallo", streamState: "online",
      });
    } finally {
      database.close();
    }
  });

  it("runs a conditioned command when Helix fails and logs unknown stream state", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertMember(database, "kanal-a", "user-1", "operator");
      await mitBot(database);
      await activate(database, "kanal-a");
      await createCommand(database);
      await database.prepare("UPDATE text_commands SET stream_condition = 'online' WHERE command_name = 'hallo'").run();
      const fetcher = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(JSON.stringify({ message: "temporary failure" }), { status: 503 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ is_sent: true, message_id: "chat-1" }] }), { status: 200 }));

      await dispatchEventSubNotification(environment(database), eventFor("!hallo"), fetcher, [textCommandModule]);

      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(requestedUrl(fetcher.mock.calls[1]?.[0])).toContain("/helix/chat/messages");
      await expect(database.prepare("SELECT COUNT(*) AS count FROM channel_stream_state").first())
        .resolves.toEqual({ count: 0 });
      const diagnostic = await database.prepare(
        "SELECT detail_json FROM event_log WHERE code = 'text_commands.triggered'",
      ).first<{ detail_json: string }>();
      expect(JSON.parse(diagnostic?.detail_json ?? "{}")).toMatchObject({ name: "hallo", streamState: "unknown" });
    } finally {
      database.close();
    }
  });

  it("stays silent on the second call within the cooldown period", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertMember(database, "kanal-a", "user-1", "operator");
      await mitBot(database);
      await activate(database, "kanal-a");
      await createCommand(database);
      const fetcher = fetcherForChat();

      await dispatchEventSubNotification(environment(database), eventFor("!hallo", "kanal-a", NOW, "trigger-2"), fetcher, [textCommandModule]);
      await dispatchEventSubNotification(environment(database), eventFor("!hallo", "kanal-a", "2026-09-19T12:00:01.000Z", "trigger-3"), fetcher, [textCommandModule]);

      expect(fetcher).toHaveBeenCalledTimes(1);
      await expect(eventCodes(database)).resolves.toContain("text_commands.cooldown");
    } finally {
      database.close();
    }
  });

  it("initializes the list command when the module is enabled", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await textCommandModule.onEnable?.({
        DB: database as unknown as D1Database,
        authorizeMutation: () => ({ sql: "AND 1 = 1", values: [] as const }),
        actor: { userId: "user-1" },
        now: NOW,
      }, "kanal-a");

      await expect(database.prepare(
        "SELECT command_name, response_text, kind, enabled FROM text_commands",
      ).all()).resolves.toEqual({
        results: [{ command_name: "befehle", response_text: "", kind: "list", enabled: 1 }],
        success: true,
        meta: { changes: 0, size: 0 },
      });
    } finally {
      database.close();
    }
  });

  it("doesn't trigger a disabled command and gives the reason in the event log", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertMember(database, "kanal-a", "user-1", "operator");
      await mitBot(database);
      await activate(database, "kanal-a");
      await createCommand(database);
      await database.prepare("UPDATE text_commands SET enabled = 0 WHERE command_name = 'hallo'").run();
      const fetcher = fetcherForChat();

      await dispatchEventSubNotification(environment(database), eventFor("!hallo", "kanal-a", NOW, "trigger-disabled-broadcaster", [{ set_id: "broadcaster" }]), fetcher, [textCommandModule]);

      expect(fetcher).not.toHaveBeenCalled();
      await expect(eventCodes(database)).resolves.toEqual(["text_commands.disabled"]);
    } finally {
      database.close();
    }
  });

  it("lets moderators trigger a moderator command and stays silent for viewers, with a diagnostic", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertMember(database, "kanal-a", "user-1", "operator");
      await mitBot(database);
      await activate(database, "kanal-a");
      await createCommand(database, "hallo", "moderator");
      const fetcher = fetcherForChat();

      await dispatchEventSubNotification(environment(database), eventFor("!hallo", "kanal-a", NOW, "trigger-moderator", [{ set_id: "moderator" }]), fetcher, [textCommandModule]);
      await dispatchEventSubNotification(environment(database), eventFor("!hallo", "kanal-a", "2026-09-19T12:00:01.000Z", "trigger-viewer"), fetcher, [textCommandModule]);

      expect(fetcher).toHaveBeenCalledTimes(1);
      const denied = await database.prepare(
        "SELECT code, detail_json FROM event_log WHERE code = 'text_commands.permission_denied'",
      ).first<{ code: string; detail_json: string }>();
      expect(denied?.code).toBe("text_commands.permission_denied");
      expect(JSON.parse(denied?.detail_json ?? "{}" )).toEqual({
        name: "hallo", requiredTier: "moderator", currentTier: ["viewer"],
      });
    } finally {
      database.close();
    }
  });

  it("treats moderators without a sub and founders as subscribers", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertMember(database, "kanal-a", "user-1", "operator");
      await mitBot(database);
      await activate(database, "kanal-a");
      await createCommand(database, "hallo", "subscriber");
      const fetcher = fetcherForChat();

      await dispatchEventSubNotification(environment(database), eventFor("!hallo", "kanal-a", NOW, "trigger-moderator", [{ set_id: "moderator" }]), fetcher, [textCommandModule]);
      await dispatchEventSubNotification(environment(database), eventFor("!hallo", "kanal-a", "2026-09-19T12:00:06.000Z", "trigger-founder", [{ set_id: "founder" }]), fetcher, [textCommandModule]);

      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      database.close();
    }
  });

  it("lists only enabled commands", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertMember(database, "kanal-a", "user-1", "operator");
      await mitBot(database);
      await activate(database, "kanal-a");
      const repository = createTextCommandRepository(
        database as unknown as D1Database,
        () => ({ sql: "AND 1 = 1", values: [] as const }),
      );
      await repository.create({ channelId: "kanal-a", name: "befehle", text: "", kind: "list", cooldownSeconds: 5, now: NOW }, { userId: "user-1" });
      await repository.create({ channelId: "kanal-a", name: "aktiv", text: "Antwort", kind: "text", cooldownSeconds: 5, now: NOW }, { userId: "user-1" });
      await repository.create({ channelId: "kanal-a", name: "aus", text: "Antwort", kind: "text", cooldownSeconds: 5, now: NOW }, { userId: "user-1" });
      await database.prepare("UPDATE text_commands SET enabled = 0 WHERE command_name = 'aus'").run();
      const fetcher = fetcherForChat();

      await dispatchEventSubNotification(environment(database), eventFor("!befehle"), fetcher, [textCommandModule]);

      expect(body(fetcher, 0).message).toBe("Befehle: !aktiv, !befehle");
    } finally {
      database.close();
    }
  });
});
