import { describe, expect, it } from "vitest";

import { readOnlyD1, DryRunWriteError } from "../../src/worker/db/read-only";
import { TestD1Database } from "./test-d1";

describe("readOnlyD1", () => {
  it("does not expose database or statement prototype escape hatches", () => {
    const database = new TestD1Database();
    const readOnly = readOnlyD1(database as unknown as D1Database) as unknown as Record<string, unknown>;

    expect(Reflect.get(readOnly, "valueOf")).toBeUndefined();
    expect(Reflect.get(readOnly, "constructor")).toBeUndefined();
    expect(Reflect.get(readOnly, "prototype")).toBeUndefined();
    expect(Reflect.get(readOnly, "batch")).toBeUndefined();
    expect(Reflect.get(readOnly, "exec")).toBeUndefined();

    const statement = readOnlyD1(database as unknown as D1Database).prepare("SELECT 1") as unknown as Record<string, unknown>;
    expect(Reflect.get(statement, "valueOf")).toBeUndefined();
    expect(Reflect.get(statement, "constructor")).toBeUndefined();
    expect(Reflect.get(statement, "prototype")).toBeUndefined();
    expect(Reflect.get(statement, "run")).toBeUndefined();
    database.close();
  });

  it("forwards only the SELECT statement methods needed by dry-run rendering", async () => {
    const nativeStatement = {
      bind: () => nativeStatement,
      first: () => Promise.resolve({ value: 1 }),
      all: () => Promise.resolve({ results: [{ value: 1 }] }),
      raw: () => Promise.resolve([[1]]),
      run: () => Promise.resolve({ success: true }),
    } as unknown as D1PreparedStatement;
    const nativeDatabase = {
      prepare: () => nativeStatement,
      batch: () => Promise.resolve([]),
      exec: () => Promise.resolve({ count: 0 }),
    } as unknown as D1Database;
    const readOnly = readOnlyD1(nativeDatabase);
    const statement = readOnly.prepare("SELECT 1").bind();

    await expect(statement.first()).resolves.toEqual({ value: 1 });
    await expect(statement.all()).resolves.toMatchObject({ results: [{ value: 1 }] });
    await expect(statement.raw()).resolves.toEqual([[1]]);
    expect(Reflect.get(statement, "run")).toBeUndefined();
  });

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
    expect(Reflect.get(readOnly, "batch")).toBeUndefined();
    expect(Reflect.get(readOnly, "exec")).toBeUndefined();
    database.close();
  });
});
