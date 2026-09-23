import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { LATEST_SCHEMA_MIGRATION, LATEST_SCHEMA_TABLE } from "../../src/worker/config";

/**
 * `/healthz` compares the most recently applied migration name against a
 * constant in the code. If the two drift apart, an otherwise error-free
 * install reports 503 — a failure nobody notices before it ruins
 * someone's launch.
 */
describe("Schema baseline", () => {
  const directory = resolve(import.meta.dirname, "../../migrations");
  const files = readdirSync(directory).filter((name) => name.endsWith(".sql")).sort();

  it("keeps LATEST_SCHEMA_MIGRATION pointed at the latest migration file", () => {
    expect(files.at(-1)).toBe(LATEST_SCHEMA_MIGRATION);
  });

  // Not every migration creates a table (0005 only backfills rows), so this
  // scans the whole history rather than assuming the latest file does it.
  it("actually creates the table /healthz checks, somewhere in the migration history", () => {
    const createsTable = files.some((file) =>
      readFileSync(resolve(directory, file), "utf8").includes(`CREATE TABLE ${LATEST_SCHEMA_TABLE} `));
    expect(createsTable).toBe(true);
  });
});
