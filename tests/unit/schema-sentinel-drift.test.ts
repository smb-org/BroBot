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
 * The health check detects a deployment that hasn't been migrated by checking
 * that the latest migration has been applied and its table exists. Both values
 * live as a constant in the worker, because it can't read the filesystem —
 * and so they silently go stale as soon as someone adds a migration
 * and forgets the constant. Then the health check reports green again even though
 * the new table is missing: exactly the failure it was built to catch.
 */
describe("Schema sentinel drift", () => {
  it("points at the latest migration in the directory", () => {
    const files = migrationFiles();

    expect(files.length).toBeGreaterThan(0);
    expect(LATEST_SCHEMA_MIGRATION).toBe(files.at(-1));
  });

  // Not every migration creates or alters a table (0005 only backfills
  // rows), so this scans the whole history rather than assuming the latest
  // file does it.
  it("names a table that some migration actually creates or alters", () => {
    const touched = migrationFiles().flatMap((file) => {
      const source = readFileSync(path.join(migrationsDirectory, file), "utf8");
      const created = [...source.matchAll(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+([A-Za-z_][A-Za-z0-9_]*)/gi)]
        .map((match) => match[1]);
      const altered = [...source.matchAll(/ALTER TABLE\s+([A-Za-z_][A-Za-z0-9_]*)/gi)]
        .map((match) => match[1]);
      const renamed = [...source.matchAll(/ALTER TABLE\s+[A-Za-z_][A-Za-z0-9_]*\s+RENAME TO\s+([A-Za-z_][A-Za-z0-9_]*)/gi)]
        .map((match) => match[1]);
      return [...created, ...altered, ...renamed];
    });

    expect(touched).toContain(LATEST_SCHEMA_TABLE);
  });
});
