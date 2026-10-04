import { describe, expect, it } from "vitest";

import { ballotChoiceFromMessage } from "../../src/modules/contract";

describe("ballotChoiceFromMessage", () => {
  it.each([
    ["1", 2, 1],
    [" 2\n", 2, 2],
    ["9", 9, 9],
  ])("accepts one trim-normalized digit within the ballot range", (text, optionCount, expected) => {
    expect(ballotChoiceFromMessage(text, optionCount)).toBe(expected);
  });

  it.each([
    ["", 2],
    ["0", 2],
    ["3", 2],
    ["10", 10],
    ["1  ", 0],
    ["one", 2],
  ])("rejects anything except one digit from 1 through N", (text, optionCount) => {
    expect(ballotChoiceFromMessage(text, optionCount)).toBeNull();
  });
});
