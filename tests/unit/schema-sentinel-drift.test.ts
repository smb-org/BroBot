import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  LATEST_SCHEMA_MIGRATION,
  LATEST_SCHEMA_TABLE,
} from "../../src/worker/config";

const migrationsDirectory = path.resolve(import.meta.dirname, "../../migrations");

const migrationFiles = (): string[] =>
  readdirSync(migrationsDirectory).filter((name) => name.endsWith(".sql")).sort();

/**
 * Der Healthcheck erkennt ein nicht migriertes Deployment daran, dass die
 * jüngste Migration angewandt und ihre Tabelle vorhanden ist. Beide Werte
 * stehen als Konstante im Worker, weil er das Dateisystem nicht lesen kann —
 * und veralten deshalb stillschweigend, sobald jemand eine Migration hinzufügt
 * und die Konstante vergisst. Dann meldet der Healthcheck wieder grün, obwohl
 * die neue Tabelle fehlt: genau der Fehler, gegen den er gebaut wurde.
 */
describe("Schema-Sentinel-Drift", () => {
  it("zeigt auf die jüngste Migration im Verzeichnis", () => {
    const files = migrationFiles();

    expect(files.length).toBeGreaterThan(0);
    expect(LATEST_SCHEMA_MIGRATION).toBe(files.at(-1));
  });

  it("nennt eine Tabelle, die genau diese Migration anlegt oder erweitert", () => {
    const source = readFileSync(path.join(migrationsDirectory, LATEST_SCHEMA_MIGRATION), "utf8");
    const created = [...source.matchAll(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+([A-Za-z_][A-Za-z0-9_]*)/gi)]
      .map((match) => match[1]);
    const altered = [...source.matchAll(/ALTER TABLE\s+([A-Za-z_][A-Za-z0-9_]*)/gi)]
      .map((match) => match[1]);

    expect([...created, ...altered]).toContain(LATEST_SCHEMA_TABLE);
  });
});
