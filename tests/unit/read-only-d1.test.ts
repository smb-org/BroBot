import { describe, expect, it } from "vitest";

import { readOnlyD1, DryRunWriteError } from "../../src/worker/db/read-only";
import { TestD1Database } from "./test-d1";

describe("readOnlyD1", () => {
  it("allows reads while rejecting statements that can write or change connection state", async () => {
    const database = new TestD1Database();
    const readOnly = readOnlyD1(database as unknown as D1Database);

    await expect(readOnly.prepare("SELECT 1 AS value").first<{ value: number }>()).resolves.toEqual({ value: 1 });
    for (const sql of [
      "INSERT INTO channels (channel_id) VALUES ('x')",
      "UPDATE channels SET language = 'en'",
      "DELETE FROM channels",
      "REPLACE INTO channels (channel_id) VALUES ('x')",
      "WITH changed AS (SELECT 1) UPDATE channels SET language = 'en'",
      "PRAGMA foreign_keys = OFF",
      "-- leading comment\n/* another comment */ INSERT INTO channels (channel_id) VALUES ('x')",
    ]) {
      expect(() => readOnly.prepare(sql)).toThrow(DryRunWriteError);
    }
    expect(() => readOnly.exec("DELETE FROM channels")).toThrow(DryRunWriteError);
    const dump = Reflect.get(readOnly, "dump") as unknown;
    expect(() => (dump as () => never)()).toThrow(DryRunWriteError);

    const statement = readOnly.prepare("SELECT 1");
    await expect(readOnly.batch([statement])).resolves.toHaveLength(1);
    expect(() => readOnly.batch([database.prepare("SELECT 1") as unknown as D1PreparedStatement]))
      .toThrow(DryRunWriteError);
    database.close();
  });
});
