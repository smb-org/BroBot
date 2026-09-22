import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { CHANNEL_ROLES } from "../../src/contracts/values";

const baselineModulePath = "../../scripts/d1-baseline.mjs";
const { generateBaseline } = await import(baselineModulePath) as unknown as {
  generateBaseline: () => string;
};

describe("SQL contract for channel roles", () => {
  it("allows exactly the values of the channel-role tuple", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(generateBaseline());
      database.prepare(
        "INSERT INTO channels (channel_id, login, display_name, created_at, updated_at, language, full_consent) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run("kanal-vertrag", "kanal-vertrag", "Kanal Vertrag", "2026-01-01", "2026-01-01", "de", 0);
      const insert = database.prepare(
        "INSERT INTO channel_members (channel_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      );

      for (const [index, role] of CHANNEL_ROLES.entries()) {
        expect(() => insert.run("kanal-vertrag", `rolle-${String(index)}`, role, "2026-01-01", "2026-01-01")).not.toThrow();
      }
      expect(() => insert.run("kanal-vertrag", "rolle-fremd", "unbekannt", "2026-01-01", "2026-01-01")).toThrow();
    } finally {
      database.close();
    }
  });
});
