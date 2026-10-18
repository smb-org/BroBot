import { describe, expect, it } from "vitest";

import { nextVariableValue } from "../../src/contracts/values";

describe("nextVariableValue", () => {
  it.each([
    { current: 7, operation: "set" as const, amount: -4, expected: -4 },
    { current: 7, operation: "set_argument" as const, amount: 12, expected: 12 },
    { current: 7, operation: "add" as const, amount: 3, expected: 10 },
    { current: 7, operation: "subtract" as const, amount: 3, expected: 4 },
    { current: 999_999_998, operation: "add" as const, amount: 4, expected: 999_999_999 },
    { current: -999_999_998, operation: "subtract" as const, amount: 4, expected: -999_999_999 },
  ])("matches SQL arithmetic for $operation", ({ current, operation, amount, expected }) => {
    expect(nextVariableValue(current, operation, amount)).toBe(expected);
  });
});
