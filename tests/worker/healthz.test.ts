import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Die Worker-Testumgebung startet mit leerer Datenbank. Der Healthcheck prüft
 * seit #43 auch das Schema, deshalb müssen die Migrationen hier angewandt
 * werden — sonst prüft der Test nur, dass ein leeres D1 als kaputt gilt.
 *
 * Die Dateien kommen über import.meta.glob, damit eine neue Migration
 * automatisch mitläuft und nicht vergessen werden kann.
 */
const migrationSources = import.meta.glob<string>("../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});

const applyMigrations = async (): Promise<void> => {
  const database = (env as unknown as { DB: D1Database }).DB;
  for (const path of Object.keys(migrationSources).sort()) {
    // Zeilenkommentare zuerst entfernen: Ein Semikolon in einem Kommentar
    // würde die Zerlegung sonst mitten im Satz auftrennen, und D1 bekäme ein
    // Fragment ohne Anweisung ("SQL code did not contain a statement").
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

describe("Worker-Grundgerüst", () => {
  it("meldet /healthz als kaputt, solange das Schema fehlt", async () => {
    const response = await exports.default.fetch(new Request("http://localhost/healthz"));
    const body = await response.json<{ status: string; missingBindings: string[] }>();

    // Genau der Fall, der bisher grün meldete: Deploy ohne angewandte Migration.
    expect(response.status).toBe(503);
    expect(body.status).toBe("misconfigured");
    expect(body.missingBindings).toContain("DB_SCHEMA");
  });

  describe("mit angewandtem Schema", () => {
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

    it("beantwortet /healthz mit dem konfigurierten Status", async () => {
      const response = await exports.default.fetch(new Request("http://localhost/healthz"));
      const body = await response.json<{ status: string; missingBindings: string[] }>();

      expect(response.status).toBe(200);
      expect(body.status).toBe("ok");
      expect(body.missingBindings).toEqual([]);
    });
  });
});
