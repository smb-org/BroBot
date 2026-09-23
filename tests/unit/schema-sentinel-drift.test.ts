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

const readMigration = (file: string): string =>
  readFileSync(path.join(migrationsDirectory, file), "utf8");

const tablesCreatedOrAltered = (source: string) => {
  const created = [...source.matchAll(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+([A-Za-z_][A-Za-z0-9_]*)/gi)]
    .map((match) => match[1]);
  const altered = [...source.matchAll(/ALTER TABLE\s+([A-Za-z_][A-Za-z0-9_]*)/gi)]
    .map((match) => match[1]);
  const renamed = [...source.matchAll(/ALTER TABLE\s+[A-Za-z_][A-Za-z0-9_]*\s+RENAME TO\s+([A-Za-z_][A-Za-z0-9_]*)/gi)]
    .map((match) => match[1]);
  return [...created, ...altered, ...renamed];
};

const tablesIndexed = (source: string) =>
  [...source.matchAll(/CREATE INDEX(?:\s+IF NOT EXISTS)?\s+[A-Za-z_][A-Za-z0-9_]*\s+ON\s+([A-Za-z_][A-Za-z0-9_]*)/gi)]
    .map((match) => match[1]);

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
    const touched = migrationFiles().flatMap((file) => tablesCreatedOrAltered(readMigration(file)));

    expect(touched).toContain(LATEST_SCHEMA_TABLE);
  });

  // The history check above only proves the sentinel table exists
  // *somewhere*; it would still pass if LATEST_SCHEMA_TABLE pointed at a
  // long-superseded table while newer migrations moved on. If the latest
  // migration touches schema at all, the sentinel must be part of what it
  // touches -- otherwise /healthz can go green on a deploy that never
  // applied the change the sentinel exists to catch.
  it("has the sentinel table among what the latest migration creates, alters or indexes, unless it's data-only", () => {
    const source = readMigration(LATEST_SCHEMA_MIGRATION);
    const touchedByLatest = [...tablesCreatedOrAltered(source), ...tablesIndexed(source)];

    if (touchedByLatest.length === 0) {
      return; // data-only migration (e.g. 0005_clips_default_on.sql) -- exempt
    }

    expect(touchedByLatest).toContain(LATEST_SCHEMA_TABLE);
  });
});
