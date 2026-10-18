import { describe, expect, it } from "vitest";

import { nextVariableValue, CHANNEL_VARIABLE_MAXIMUM_VALUE, CHANNEL_VARIABLE_MINIMUM_VALUE } from "../../src/contracts/values";
import { createTextCommandRepository } from "../../src/modules/text_commands/adapters/d1";
import { prepareChannelVariableChange } from "../../src/worker/db/channel-variables";
import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

const NOW = "2026-09-19T12:00:00.000Z";

describe("nextVariableValue SQL parity", () => {
  it.each([
    { current: 7, operation: "set" as const, amount: -4, expected: -4 },
    { current: 7, operation: "set_argument" as const, amount: 0, expected: 0 },
    { current: 7, operation: "add" as const, amount: 3, expected: 10 },
    { current: 7, operation: "subtract" as const, amount: 3, expected: 4 },
    { current: CHANNEL_VARIABLE_MAXIMUM_VALUE - 1, operation: "add" as const, amount: 4, expected: CHANNEL_VARIABLE_MAXIMUM_VALUE },
    { current: CHANNEL_VARIABLE_MINIMUM_VALUE + 1, operation: "subtract" as const, amount: 4, expected: CHANNEL_VARIABLE_MINIMUM_VALUE },
  ])("matches D1 for $operation with current value $current", async ({ current, operation, amount, expected }) => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await database.prepare(
        "INSERT INTO channel_variables (channel_id, name, value, created_at, updated_at) VALUES ('kanal-a', 'score', ?, ?, ?)",
      ).bind(current, NOW, NOW).run();
      const repository = createTextCommandRepository(
        database as unknown as D1Database,
        () => ({ sql: "AND 1 = 1", values: [] }),
      );
      await repository.create({
        channelId: "kanal-a",
        name: "action",
        text: "",
        kind: "text",
        cooldownSeconds: 0,
        variableAction: { name: "score", operation, amount },
        now: NOW,
      }, { userId: "member-1" });
      const command = await repository.find("kanal-a", "action");
      expect(command).not.toBeNull();
      const write = prepareChannelVariableChange(database as unknown as D1Database, "kanal-a", {
        name: "score",
        operation,
        amount,
      }, NOW, { commandName: "action", revision: command?.revision ?? 0, userId: null });
      await database.batch([write as unknown as Parameters<TestD1Database["batch"]>[0][number]]);
      const variable = await database.prepare(
        "SELECT value FROM channel_variables WHERE channel_id = 'kanal-a' AND name = 'score'",
      ).first<{ value: number }>();
      const actual = variable?.value;

      expect(actual).toBe(expected);
      expect(nextVariableValue(current, operation, amount)).toBe(actual);
    } finally {
      database.close();
    }
  });
});
