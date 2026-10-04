import { describe, expect, it } from "vitest";

import { TestD1Database } from "./test-d1";

describe("SQLite test adapter", () => {
  it("requires the exact number of positional bindings", async () => {
    const database = new TestD1Database();
    try {
      expect(() => database.prepare("SELECT ?, ?").bind("only-one"))
        .toThrow("expected 2 bind values but received 1");
      expect(() => database.prepare("SELECT ?").bind("one", "extra"))
        .toThrow("expected 1 bind values but received 2");
      await expect(database.prepare("SELECT '?' AS literal, ? AS value -- ? ignored\n/* ? ignored */")
        .bind("kept")
        .first()).resolves.toEqual({ literal: "?", value: "kept" });
    } finally {
      database.close();
    }
  });
});
