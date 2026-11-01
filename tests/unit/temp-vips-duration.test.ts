import { describe, expect, it } from "vitest";

import { parseVipDuration } from "../../src/modules/temp_vips/domain";

describe("temporary VIP duration parser", () => {
  it.each([
    ["10m", 10 * 60_000],
    ["30m", 30 * 60_000],
    ["12h", 12 * 60 * 60_000],
    ["7d", 7 * 24 * 60 * 60_000],
    ["7t", 7 * 24 * 60 * 60_000],
    ["2w", 14 * 24 * 60 * 60_000],
  ])("parses %s", (input, expected) => {
    expect(parseVipDuration(input)).toBe(expected);
  });

  it.each(["9m", "0m", "-30m", "3x", "1.5h", "999999999999999999999d", "30m extra", ""])(
    "rejects invalid or too-short duration %s",
    (input) => {
      expect(parseVipDuration(input)).toBeNull();
    },
  );
});
