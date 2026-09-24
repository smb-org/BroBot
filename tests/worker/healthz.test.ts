import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { OVERLAY_TOKEN_SUBPROTOCOL_PREFIX, REALTIME_PROTOCOL } from "../../src/realtime-contract";
import { hashOverlayToken } from "../../src/worker/auth/crypto";

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
  for (const path of Object.keys(migrationSources).sort()) {
    // Strip line comments first: a semicolon inside a comment would otherwise
    // split the statement mid-sentence, and D1 would get a fragment with no
    // statement ("SQL code did not contain a statement").
    const statements = (migrationSources[path] ?? "")
      .split(/\r?\n/)
      .map((zeile) => zeile.replace(/^\s*--.*$/, ""))
      .join("\n")
      .split(";")
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);
    for (const statement of statements) {
      await database.prepare(statement).run();
    }
    await database.prepare(
      "INSERT INTO d1_migrations (name, applied_at) VALUES (?, ?)",
    ).bind(path.split("/").pop(), new Date().toISOString()).run();
  }
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
