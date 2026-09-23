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

  it("keeps the latest migration's indexed table aligned with the health check", () => {
    const migration = readFileSync(resolve(directory, LATEST_SCHEMA_MIGRATION), "utf8");
    expect(migration).toMatch(new RegExp(`CREATE\\s+INDEX\\s+\\w+\\s+ON\\s+${LATEST_SCHEMA_TABLE}\\s*\\(`, "i"));
  });
});
