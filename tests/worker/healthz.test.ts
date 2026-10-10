import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { OVERLAY_TOKEN_SUBPROTOCOL_PREFIX, REALTIME_PROTOCOL } from "../../src/realtime-contract";
import { hashOverlayToken } from "../../src/worker/auth/crypto";
import type { ModuleTemplateValueContext } from "../../src/modules/contract";
import { sunModule, resolveSunTemplateValues } from "../../src/modules/sun";
import { readChannelLocation } from "../../src/worker/db/channel-settings";
import { LATEST_SCHEMA_MIGRATION } from "../../src/worker/config";

/**
 * The worker test environment starts with an empty database. Since #43, the
 * healthcheck also checks the schema, so the migrations must be applied here
 * — otherwise the test only checks that an empty D1 counts as broken.
 *
 * The files come in via import.meta.glob, so a new migration runs
 * automatically and can't be forgotten.
 */
const migrationSources = import.meta.glob<string>("../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});

const applyMigrations = async (): Promise<void> => {
  const database = (env as unknown as { DB: D1Database }).DB;
  for (const path of Object.keys(migrationSources).sort((a, b) => a.localeCompare(b))) {
    const filename = path.split("/").pop();
    if (filename === "0019_sun_data_source.sql") {
      await database.prepare(
        `INSERT INTO channels (channel_id, login, display_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(MIGRATION_CHANNEL_ID, MIGRATION_CHANNEL_ID, "Migration channel", "2026-09-27T00:00:00.000Z", "2026-09-27T00:00:00.000Z").run();
    }
    // Strip line comments first: a semicolon inside a comment would otherwise
    // split the statement mid-sentence, and D1 would get a fragment with no
    // statement ("SQL code did not contain a statement").
    const migrationSql = (migrationSources[path] ?? "")
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*--.*$/, ""))
      .join("\n")
      .split(";");
    const statements: string[] = [];
    let triggerStatement: string[] | null = null;
    for (const segment of migrationSql) {
      const statement = segment.trim();
      if (statement.length === 0) continue;
      if (triggerStatement !== null) {
        if (statement.toUpperCase() === "END") {
          statements.push(`${triggerStatement.join(";")};${statement}`);
          triggerStatement = null;
        } else {
          triggerStatement.push(statement);
        }
      } else if (/^CREATE\s+TRIGGER\b/i.test(statement)) {
        triggerStatement = [statement];
      } else {
        statements.push(statement);
      }
    }
    for (const statement of statements) {
      await database.prepare(statement).run();
    }
    if (filename === "0019_sun_data_source.sql") {
      await database.prepare(
        `INSERT INTO sun_locations
          (channel_id, name, latitude, longitude, location_time_zone, error_text_de, error_text_en, revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(MIGRATION_CHANNEL_ID, "Tromsø, Norway", 69.6492, 18.9553, "Europe/Oslo", "Fehler DE", "Error EN", 4).run();
    }
    await database.prepare(
      "INSERT INTO d1_migrations (name, applied_at) VALUES (?, ?)",
    ).bind(path.split("/").pop(), new Date().toISOString()).run();
  }
};

const MIGRATION_CHANNEL_ID = `migration-${crypto.randomUUID()}`;

const sunSetForHostLocation = async (DB: D1Database, channelId: string, now: number): Promise<string | undefined> => {
  const context: ModuleTemplateValueContext = {
    DB,
    channelId,
    secrets: {
      status: () => Promise.resolve({ configured: false, updatedAt: null }),
      read: () => Promise.resolve(null),
      readWithVersion: () => Promise.resolve(null),
    },
    templateContext: "chat_command",
    knownTemplateVariableNames: new Set(["sun.set"]),
    chatStatus: null,
    mode: "chat",
    channelLanguage: () => Promise.resolve("en"),
    streamState: () => Promise.resolve("offline"),
    channelInfo: () => Promise.resolve(null),
    channelTimeZone: () => Promise.resolve("Europe/Berlin"),
    channelLocation: () => readChannelLocation(DB, channelId),
    renderTemplate: (text) => Promise.resolve({ text, diagnostics: [] }),
    addDiagnostic: () => undefined,
    now,
    resolveTemplateConditions: () => Promise.resolve({}),
  };
  const values = await sunModule.resolveTemplateValues?.(["sun.set"], context);
  return values?.["sun.set"];
};

describe("worker skeleton", () => {
  it("reports /healthz as broken as long as the schema is missing", async () => {
    const response = await exports.default.fetch(new Request("http://localhost/healthz"));
    const body = await response.json<{ status: string; missingBindings: string[] }>();

    // Exactly the case that used to report green: a deploy without an applied migration.
    expect(response.status).toBe(503);
    expect(body.status).toBe("misconfigured");
    expect(body.missingBindings).toContain("DB_SCHEMA");
  });

  /**
   * The asset handler runs with `not_found_handling: single-page-application`,
   * so without this route an unknown API path answers 200 with `index.html` and
   * the caller reports "Unexpected token '<'". A renamed endpoint then looks
   * like a parser bug rather than a missing route.
   */
  it("answers an unknown API path with 404 as JSON, not with the app shell", async () => {
    const response = await exports.default.fetch(new Request("http://localhost/api/does-not-exist"));

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toMatchObject({ error: expect.any(String) as unknown as string });
  });

  describe("with schema applied", () => {
    beforeAll(async () => {
      await (env as unknown as { DB: D1Database }).DB.prepare(
        `CREATE TABLE IF NOT EXISTS d1_migrations (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           name TEXT UNIQUE,
           applied_at TEXT NOT NULL
         )`,
      ).run();
      await applyMigrations();
    });

    it("responds to /healthz with the configured status", async () => {
      const response = await exports.default.fetch(new Request("http://localhost/healthz"));
      const body = await response.json<{ status: string; missingBindings: string[] }>();

      expect(response.status).toBe(200);
      expect(body.status).toBe("ok");
      expect(body.missingBindings).toEqual([]);
    });

    it("checks the schema by highest migration number, not by application order", async () => {
      const database = (env as unknown as { DB: D1Database }).DB;
      const status = async () => (await exports.default.fetch(new Request("http://localhost/healthz"))).status;
      const sentinel: string = LATEST_SCHEMA_MIGRATION;
      const original = (await database.prepare("SELECT name FROM d1_migrations WHERE name LIKE '0040_%' OR name = ?")
        .bind(sentinel).all<{ name: string }>()).results.map((row) => row.name);
      const reinsert = async (names: string[]): Promise<void> => {
        await database.prepare("DELETE FROM d1_migrations WHERE name LIKE '0040_%' OR name = ?").bind(sentinel).run();
        for (const name of names) {
          await database.prepare("INSERT INTO d1_migrations (name, applied_at) VALUES (?, ?)")
            .bind(name, new Date().toISOString()).run();
        }
      };
      try {
        // 0040 applied last (highest id) but the highest number is still 0047.
        await reinsert(original.filter((name) => name === sentinel).concat(original.filter((name) => name !== sentinel)));
        expect(await status()).toBe(200);

        await reinsert(original.filter((name) => name !== sentinel));
        expect(await status()).toBe(503);
      } finally {
        await reinsert(original);
      }
    });

    it("moves a legacy sun location into the host channel row", async () => {
      const database = (env as unknown as { DB: D1Database }).DB;
      try {
        const channel = await database.prepare(
          `SELECT location_name, location_latitude, location_longitude, location_time_zone, location_revision
             FROM channels WHERE channel_id = ?`,
        ).bind(MIGRATION_CHANNEL_ID).first();
        const settings = await database.prepare(
          "SELECT error_text_de, error_text_en, revision FROM sun_settings WHERE channel_id = ?",
        ).bind(MIGRATION_CHANNEL_ID).first();
        const oldTable = await database.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sun_locations'",
        ).first<{ name: string }>();

        expect(channel).toEqual({
          location_name: "Tromsø, Norway",
          location_latitude: 69.6492,
          location_longitude: 18.9553,
          location_time_zone: "Europe/Oslo",
          location_revision: 4,
        });
        expect(settings).toEqual({ error_text_de: "Fehler DE", error_text_en: "Error EN", revision: 4 });
        expect(oldTable).toBeNull();
        const now = Date.UTC(2026, 0, 15, 12, 0, 0);
        const output = await sunSetForHostLocation(database, MIGRATION_CHANNEL_ID, now);
        const expected = resolveSunTemplateValues({
          location: {
            latitude: 69.6492,
            longitude: 18.9553,
            timeZone: "Europe/Oslo",
          },
          now,
          timeZone: "Europe/Berlin",
          language: "en",
          errorText: "Error EN",
        }).values["sun.set"];

        expect(output).toBe(expected);
        expect(output).not.toBe("Error EN");
      } finally {
        await database.prepare("DELETE FROM channels WHERE channel_id = ?").bind(MIGRATION_CHANNEL_ID).run();
      }
    });

    it("performs the public overlay WebSocket handshake with only brobot.v1 selected", async () => {
      const bindings = env as unknown as Env;
      const database = bindings.DB;
      const channelId = `realtime-handshake-${crypto.randomUUID()}`;
      const tokenId = `realtime-token-${crypto.randomUUID()}`;
      const token = "A".repeat(43);
      const now = new Date().toISOString();
      const tokenHash = await hashOverlayToken(token, bindings.OVERLAY_TOKEN_PEPPER);
      await database.prepare(
        `INSERT INTO channels (channel_id, login, display_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(channelId, channelId, channelId, now, now).run();
      await database.prepare(
        `INSERT INTO overlay_tokens
          (token_id, channel_id, token_hash, expires_at, created_at, revoked_at, revocation_reason, last_used_at)
         VALUES (?, ?, ?, NULL, ?, NULL, NULL, NULL)`,
      ).bind(tokenId, channelId, tokenHash, now).run();

      const response = await exports.default.fetch(new Request("http://localhost/ws/overlay", {
        headers: {
          Upgrade: "websocket",
          "Sec-WebSocket-Protocol": `${REALTIME_PROTOCOL}, ${OVERLAY_TOKEN_SUBPROTOCOL_PREFIX}${token}`,
        },
      }));
      const selectedProtocol = response.headers.get("Sec-WebSocket-Protocol");

      expect(response.status).toBe(101);
      expect(selectedProtocol).toBe(REALTIME_PROTOCOL);
      expect(selectedProtocol).not.toContain(OVERLAY_TOKEN_SUBPROTOCOL_PREFIX);
      expect(selectedProtocol).not.toContain(token);
      const clientSocket = (response as Response & { webSocket?: WebSocket }).webSocket;
      clientSocket.accept();
      clientSocket.close(1000, "test complete");
    });

  });
});
