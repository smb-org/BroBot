import { describe, expect, it, vi } from "vitest";

import { textCommandModule, type TextCommandMinimumTier } from "../../src/modules/text_commands";
import { createTextCommandRepository } from "../../src/modules/text_commands/adapters/d1";
import { dispatchEventSubNotification } from "../../src/worker/dispatch";
import {
  upsertBotIdentity,
} from "../../src/worker/db/bot-identity";
import { encryptJson, parseKeyRing } from "../../src/worker/auth/crypto";
import { insertAppAccessToken, insertChannel, insertMember } from "./fixtures";
import { TestD1Database } from "./test-d1";

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
        "text_commands.triggered",
        "template_truncated",
        "host.chat.sent",
      ]);
      expect(JSON.parse(rows.results[1]?.detail_json ?? "{}")).toEqual({ current: 508 });
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
