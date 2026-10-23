import { describe, expect, it } from "vitest";

import { votekickThreshold } from "../../src/modules/votekick/domain";

describe("votekickThreshold", () => {
  it.each([
    [5, 20, 34, 7],
    [10, 20, 34, 10],
    [3, 5, 1, 3],
    [3, 5, 60, 3],
    [3, 5, 61, 4],
    [1, 100, 0, 1],
    [3, 100, 100, 100],
  ])("returns the maximum of the floor and rounded-up chatter share", (minimum, percent, chatter, expected) => {
    expect(votekickThreshold(minimum, percent, chatter)).toBe(expected);
  });

  it.each([
    [0, 20, 34],
    [3, 0, 34],
    [3, 101, 34],
    [3, 20, -1],
    [Number.NaN, 20, 34],
  ])("rejects invalid input values", (minimum, percent, chatter) => {
    expect(() => votekickThreshold(minimum, percent, chatter)).toThrow(RangeError);
  });
});
