import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { LATEST_SCHEMA_MIGRATION, LATEST_SCHEMA_TABLE } from "../../src/worker/config";

/**
 * `/healthz` vergleicht den zuletzt angewandten Migrationsnamen mit einer
 * Konstante im Code. Laufen die beiden auseinander, meldet eine fehlerfreie
 * Installation 503 — ein Fehler, der niemandem auffällt, bevor er jemandem
 * den Start verdirbt.
 */
describe("Schema-Baseline", () => {
  const directory = resolve(import.meta.dirname, "../../migrations");
  const files = readdirSync(directory).filter((name) => name.endsWith(".sql")).sort();

  it("hält LATEST_SCHEMA_MIGRATION an der letzten Migrationsdatei", () => {
    expect(files.at(-1)).toBe(LATEST_SCHEMA_MIGRATION);
  });

  it("legt die von /healthz geprüfte Tabelle wirklich an", () => {
    const baseline = readFileSync(resolve(directory, LATEST_SCHEMA_MIGRATION), "utf8");
    expect(baseline).toContain(`CREATE TABLE ${LATEST_SCHEMA_TABLE} `);
  });
});
