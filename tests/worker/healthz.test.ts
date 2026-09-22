import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

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
  });
});
